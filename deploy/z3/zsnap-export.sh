#!/usr/bin/env bash
# Scheduled snapshot export for the z3 zebra state (issue #7, "zsnap").
#
# Runs `zebrad export-snapshot` from the snapshot-capable build against the
# chain volume, compresses the result, and rotates old archives.
#
# Two modes, ZSNAP_MODE:
#   hot (default)   Export against the live node, zero downtime. The fork
#                   opens the state in RocksDB read-only secondary mode
#                   (disk_db.rs, commit 21512fe), which cannot write to the
#                   primary. A secondary open can still lose a race with the
#                   primary's WAL rotation and fail with a transient IOError
#                   (seen once mid-initial-sync, panics with a misleading
#                   "already open" hint), which is why the export retries.
#   cold            Fall back to a brief maintenance window if hot flakes:
#                   stop the watchdog (it would docker-start zebra 30s into
#                   the window), stop the zebra container, export with
#                   exclusive access, restart everything. A trap plus the
#                   unit's ExecStopPost recover pass restart zebra and the
#                   watchdog on EVERY exit path, so a failed export never
#                   leaves the node down. Window is stop + export + start.
#
# What lands in $ZSNAP_DIR/snapshots per run:
#   zsnap-<net>-<height>-<hash12>.tar.zst                the snapshot
#   zsnap-<net>-<height>-<hash12>.tar.zst.manifest-hash  its identity
#   latest.tar.zst / latest.manifest-hash                symlinks to the above
#
# The manifest hash is the snapshot's identity. zsnap-import.sh feeds it to
# `zebrad import-snapshot --expect-hash`, which then verifies every chunk
# before any of it touches a state directory. Keep the hash with the archive
# (the sidecar) and, for real disaster recovery, also somewhere the box can
# lose (see SNAPSHOTS.md).
#
# Two gates, both skipped with ZSNAP_FORCE=1:
#   - zebra must report ready (a mid-sync snapshot is valid but stale, and
#     rotation would evict a better one to keep it)
#   - free space must be ~1.5x the state size (raw export + archive peak)
#
# Everything is env-configurable. Logs go to stdout so journald keeps them.
# Run it under zsnap-export.timer, or by hand for a one-off.
set -euo pipefail

# Shared config, same file the systemd units load (harmless to source twice).
# shellcheck disable=SC1091
[ -f /etc/faucet/zsnap.env ] && . /etc/faucet/zsnap.env

ZSNAP_NETWORK="${ZSNAP_NETWORK:-testnet}"
ZSNAP_MODE="${ZSNAP_MODE:-hot}"
ZSNAP_ZEBRAD="${ZSNAP_ZEBRAD:-/opt/zebrad-miner}"
ZSNAP_CHAIN_VOLUME="${ZSNAP_CHAIN_VOLUME:-z3-${ZSNAP_NETWORK}-chain}"
ZSNAP_DIR="${ZSNAP_DIR:-/var/lib/zsnap}"
# Three generations, so no single snapshot is a point of failure and a recent
# one always exists. zsnap-import.sh walks them newest to oldest.
ZSNAP_KEEP="${ZSNAP_KEEP:-3}"
ZSNAP_FORCE="${ZSNAP_FORCE:-0}"               # 1 = skip the ready and space gates
ZSNAP_RETRIES="${ZSNAP_RETRIES:-3}"           # export attempts before giving up
ZSNAP_RETRY_WAIT="${ZSNAP_RETRY_WAIT:-30}"    # seconds between attempts
ZSNAP_PREFLIGHT_TRIES="${ZSNAP_PREFLIGHT_TRIES:-3}"  # opens before preflight says NO-GO
ZSNAP_PREFLIGHT_WAIT="${ZSNAP_PREFLIGHT_WAIT:-3}"    # seconds between those
ZSNAP_READY_TRIES="${ZSNAP_READY_TRIES:-10}"         # ready probes before giving up
ZSNAP_READY_WAIT="${ZSNAP_READY_WAIT:-30}"           # seconds between those
ZSNAP_UPLOAD_CMD="${ZSNAP_UPLOAD_CMD:-}"      # optional: run <cmd> <archive> after export
# Container/service names for the cold-mode window. The zebra container is
# matched by name substring, same convention as watchdog.sh.
ZSNAP_ZEBRA_MATCH="${ZSNAP_ZEBRA_MATCH:-zebra}"
ZSNAP_WATCHDOG_UNIT="${ZSNAP_WATCHDOG_UNIT:-faucet-watchdog}"
ZSNAP_STOP_TIMEOUT="${ZSNAP_STOP_TIMEOUT:-90}" # seconds for a graceful zebra stop
# z3 publishes zebra's health endpoint on 18080 for testnet, 8080 for mainnet.
if [ "$ZSNAP_NETWORK" = "testnet" ]; then default_ready="http://127.0.0.1:18080/ready"
else default_ready="http://127.0.0.1:8080/ready"; fi
ZSNAP_READY_URL="${ZSNAP_READY_URL:-$default_ready}"

log() { echo "$(date -u +%FT%TZ) zsnap-export: $*"; }
die() { log "ERROR: $*"; exit 1; }

# ZSNAP_KEEP=0 makes the rotation below `tail -n +1`, which deletes every snapshot
# including the one this run just made and verified. Placed after die() rather than beside
# the assignment, because a guard that calls die before die exists gives
# command-not-found and exit 127, which is a worse failure than the one it guards. I
# shipped that mistake twice today before writing it down.
case "$ZSNAP_KEEP" in
  ''|*[!0-9]*) die "ZSNAP_KEEP must be a whole number, got '$ZSNAP_KEEP'" ;;
esac
[ "$ZSNAP_KEEP" -ge 1 ] \
  || die "ZSNAP_KEEP must be at least 1, got $ZSNAP_KEEP: rotation would delete the snapshot this run just made"

# `zsnap-export.sh recover` puts the stack back after an abnormal death (a
# SIGKILL skips every trap). The window marker below records what was stopped.
# The systemd unit runs this via ExecStopPost, so even a timed-out export
# cannot leave zebra down and the watchdog paused. Harmless when no marker.
window_marker="$ZSNAP_DIR/.window"
if [ "${1:-}" = "recover" ]; then
  [ -f "$window_marker" ] || exit 0
  read -r marked_zebra marked_watchdog < "$window_marker" || true
  log "recovering from an interrupted window (zebra=$marked_zebra watchdog=$marked_watchdog)"
  if [ -n "${marked_zebra:-}" ] && [ "$marked_zebra" != "-" ]; then
    docker start "$marked_zebra" >/dev/null 2>&1 || true
  fi
  if [ "${marked_watchdog:-0}" = "1" ]; then
    systemctl start "$ZSNAP_WATCHDOG_UNIT" >/dev/null 2>&1 || true
  fi
  rm -f "$window_marker"
  exit 0
fi

# THE FIRST VERSION OF THIS COMPARED TWO DIFFERENT QUANTITIES AND SO COULD NEVER
# PASS. It took sha256 of MANIFEST.json's raw bytes and compared it to the hash
# zebrad reports. Those are unrelated numbers, so from the day it shipped
# (2026-08-02) it rejected every export: seven in a row, none of them faulty,
# `latest` frozen at a two-day-old height while a good snapshot sat beside it
# renamed `.unverified`. Nobody saw it, because the unit fails on purpose so
# systemctl is the last signal and no alert reaches a human (#215). #404.
#
# It also rejects the snapshot that is `latest` right now, which is how the
# diagnosis was settled: a check that fails against a KNOWN-GOOD artefact is
# broken in itself, not reporting on the artefact.
#
# WHAT THE HASH ACTUALLY IS: BLAKE2b-256 personalized with "ZebraSnapshotV1",
# over a canonical text ("zsnap-canonical-v2") built from the identity fields
# and the sorted per-chunk entries of the CONSENSUS column families only. It is
# not a hash of the JSON file, and no amount of trying sha256/blake2b/sha3 over
# the file, the compacted JSON, or the concatenated chunk hashes finds it -
# twenty-odd candidates, all wrong. The answer is in the fork,
# `zebra-state/src/snapshot.rs`, `canonical_manifest_hash`.
#
# THE TEXT BELOW IS A THIRD COPY and can drift from the fork's two (the Rust
# function and `attestations/verify.sh`). Drift shows up as a mismatch on a
# perfectly good archive, which is precisely the failure being fixed here, so
# that message names drift as the likely cause instead of blaming the snapshot.
#
# AND IT NOW CHECKS THE PAYLOAD, NOT ONLY ITS DESCRIPTION. The old check read
# the manifest and never opened a chunk, so once the hash comparison was right
# it would still have passed an archive whose chunks were truncated - the
# disk-full case this whole step exists for. Every chunk is hashed against its
# manifest entry now.
#
# ONE STREAMING PASS, and that makes it cheaper than what it replaces: the old
# code decompressed the whole 9 GB archive three separate times (zstd -t, then
# tar -tf, then tar -xO). Nothing is expanded to disk, for the reason the header
# gives - a verification step that needs a third copy of the state is the one
# that gets deleted the first time it fills the volume.
VERIFY_FAIL=""
verify_snapshot() { # $1 archive, $2 expected manifest hash
  local a="$1" want="$2" out rc
  VERIFY_FAIL=""
  set +e
  out="$(zstd -dc "$a" 2>/dev/null | verify_stream "$want" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "$out" | while IFS= read -r line; do log "  $line"; done
    return 0
  fi
  # The first line is the machine-readable reason, kept beside a rejected
  # archive so the file can be read on its own months later; the rest is detail.
  VERIFY_FAIL="$(printf '%s' "$out" | head -1)"
  [ -n "$VERIFY_FAIL" ] || VERIFY_FAIL="verifier-produced-nothing"
  log "ERROR: the snapshot did not verify: $VERIFY_FAIL"
  printf '%s\n' "$out" | tail -n +2 | while IFS= read -r line; do log "  $line"; done
  log "  zsnap-import authenticates against this hash, so it would refuse this snapshot."
  return 1
}

# Reads a tar stream on stdin. Exit 0 verified, 1 rejected with the reason on
# the first stdout line, 2 could not run - which is not a pass.
#
# python3 rather than jq: jq is not on this box's dependency list, python3 is
# (the zsnap, backup and deploy suites all require it), and this needs a real
# JSON parser plus a personalized BLAKE2b that shell has no way to reach.
#
# THE PROGRAM IS PASSED WITH -c, NOT FED ON STDIN, and that is not a style choice.
# `python3 - "$1" <<'PY'` reads the PROGRAM from stdin, so the heredoc replaces the
# tar stream this function is supposed to read and every archive comes back
# "not-a-readable-tar: empty file". Stdin cannot be both the source code and the
# data. Caught by running it against a known-good archive, which is the same
# control that caught the bug this whole function exists to fix.
verify_stream() {
  local prog
  prog="$(cat <<'PY'
import hashlib, json, sys, tarfile

# All three constants are from zebra-state/src/snapshot.rs in the fork and none
# is derivable from the manifest, which is why they are quoted with their source.
PERSON = b"ZebraSnapshotV1"
PREFIX = "zsnap-canonical-v2\n"
# Excluded from the identity so two honest nodes at the same height agree on it.
NON_CONSENSUS = {"block_info"}
MANIFEST = "snapshot/MANIFEST.json"
CHUNKS = "snapshot/"

def fail(reason, *detail):
    print(reason)
    for d in detail:
        print(d)
    sys.exit(1)

if len(sys.argv) != 2:
    print("usage: <tar stream> | verify_stream EXPECTED_HASH")
    sys.exit(2)
want = sys.argv[1].strip().lower()

raw, seen = None, {}
try:
    # "r|" is the streaming mode: sequential, no seeking, nothing to disk.
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as tf:
        for m in tf:
            if not m.isfile():
                continue
            f = tf.extractfile(m)
            if f is None:
                continue
            if m.name == MANIFEST:
                raw = f.read()
                continue
            if not m.name.startswith(CHUNKS):
                continue
            h = hashlib.blake2b(digest_size=32, person=PERSON)
            n = 0
            while True:
                b = f.read(1 << 20)
                if not b:
                    break
                n += len(b)
                h.update(b)
            seen[m.name[len(CHUNKS):]] = (n, h.hexdigest())
except tarfile.TarError as e:
    fail("not-a-readable-tar", "  tar error: %s" % e)
except (OSError, EOFError) as e:
    # A truncated stream lands here, which is the disk-full case this exists for.
    fail("archive-truncated-or-unreadable", "  %s" % e)

if raw is None:
    fail("no-manifest", "  no %s inside the archive" % MANIFEST)
try:
    man = json.loads(raw)
    chunks = man["chunks"]
except ValueError as e:
    fail("manifest-not-json", "  %s" % e)
except (KeyError, TypeError) as e:
    fail("manifest-shape-unexpected", "  %s" % e)

missing, bad_size, bad_hash = [], [], []
for c in chunks:
    got = seen.get(c["file"])
    if got is None:
        missing.append(c["file"])
        continue
    n, h = got
    if n != c["bytes"]:
        bad_size.append("  %s: manifest says %d bytes, archive has %d" % (c["file"], c["bytes"], n))
    elif h != c["blake2b256"]:
        bad_hash.append("  %s: content hash differs from the manifest" % c["file"])
if missing:
    fail("chunk-missing", *["  " + m for m in missing[:10]])
if bad_size:
    fail("chunk-size-mismatch", *bad_size[:10])
if bad_hash:
    fail("chunk-hash-mismatch", *bad_hash[:10])

try:
    parts = [PREFIX]
    for k in ("network", "tip_height", "tip_hash", "db_format_version", "snapshot_format"):
        parts.append("%s=%s\n" % (k, man[k]))
    cs = sorted((c for c in chunks if c["name"] not in NON_CONSENSUS), key=lambda c: c["name"])
    for c in cs:
        parts.append("chunk=%s,%s,%s,%s\n" % (c["name"], c["records"], c["bytes"], c["blake2b256"]))
    got = hashlib.blake2b("".join(parts).encode(), digest_size=32, person=PERSON).hexdigest()
except (KeyError, TypeError) as e:
    fail("manifest-missing-identity-field", "  %s" % e)

if got != want:
    fail("manifest-hash-mismatch",
         "  zebrad reported: %s" % want,
         "  recomputed     : %s" % got,
         "  Every chunk verified against the manifest, so the PAYLOAD is intact and only",
         "  the identity differs. The likeliest cause is the canonical text in this script",
         "  drifting from canonical_manifest_hash in zebra-state/src/snapshot.rs, not a bad",
         "  snapshot. Check attestations/verify.sh in the fork before blaming the export.")

print("verified: %d chunks, each present with the listed size and content hash" % len(chunks))
print("manifest hash %s matches what zebrad reported" % got)
PY
  )"
  python3 -c "$prog" "$1"
}

# A seam for the suite, so the verifier is tested through the code that runs in
# production rather than through a copy of it. Placed before the export work
# because everything below assumes it is about to snapshot a node.
if [ "${1:-}" = "--verify-only" ]; then
  [ $# -eq 3 ] || { echo "usage: $0 --verify-only ARCHIVE EXPECTED_HASH" >&2; exit 2; }
  verify_snapshot "$2" "$3" || exit 1
  exit 0
fi

# `zsnap-export.sh preflight` answers one question: can THIS export binary
# open THIS node's chain state? That is the only real compatibility question,
# and it has a cheap definitive answer, so nobody has to reason about version
# numbers. `tip-height` opens the state read-only through the same code path
# the export uses and prints the tip, so a clean run means an export can run,
# and a format mismatch fails here in a second instead of mid-export.
#
# Run it before the first export on any box, and after upgrading either the
# node image or the export binary. Exit 0 means go.
if [ "${1:-}" = "preflight" ]; then
  [ -x "$ZSNAP_ZEBRAD" ] || die "no snapshot-capable zebrad at $ZSNAP_ZEBRAD (set ZSNAP_ZEBRAD)"
  cache_dir="$(docker volume inspect -f '{{.Mountpoint}}' "$ZSNAP_CHAIN_VOLUME" 2>/dev/null)" \
    || die "chain volume $ZSNAP_CHAIN_VOLUME not found (is the z3 stack on this box?)"

  # The state directory is state/v<major>/<network>, so the major format
  # version the node wrote is visible without opening anything.
  on_disk="$(find "$cache_dir/state" -maxdepth 1 -type d -name 'v*' -exec basename {} \; 2>/dev/null | tr '\n' ' ')"
  log "chain volume:   $ZSNAP_CHAIN_VOLUME ($cache_dir)"
  log "state formats:  ${on_disk:-none found}"
  log "export binary:  $ZSNAP_ZEBRAD"

  # Deliberately not under $ZSNAP_DIR: preflight runs before the snapshot
  # directory exists on a fresh box, and it should work there too.
  out="$(mktemp "${TMPDIR:-/tmp}/zsnap-preflight.XXXXXX")"
  trap 'rm -f "$out"' EXIT

  # Retry before declaring NO-GO. A read-only open on a busy node can lose a
  # race with the primary's WAL rotation and fail transiently, and that error
  # looks like a format mismatch to anyone reading it. The whole point of
  # preflight is to stop people guessing between those two, so it settles the
  # question itself: a real mismatch fails every attempt, a race does not.
  attempt=1
  while :; do
    if "$ZSNAP_ZEBRAD" tip-height --cache-dir "$cache_dir" --network "$ZSNAP_NETWORK" > "$out" 2>&1; then
      log "GO: the export binary opened the state, tip height $(tail -n1 "$out")"
      exit 0
    fi
    [ "$attempt" -lt "$ZSNAP_PREFLIGHT_TRIES" ] || break
    log "attempt $attempt failed, retrying in ${ZSNAP_PREFLIGHT_WAIT}s (a busy node can fail one open transiently)"
    attempt=$((attempt + 1))
    sleep "$ZSNAP_PREFLIGHT_WAIT"
  done

  log "NO-GO: the export binary could not open this state in $ZSNAP_PREFLIGHT_TRIES attempts"
  sed 's/^/    /' "$out" | tail -n 20
  die "see SNAPSHOTS.md, 'When the export binary and the node disagree'"
fi

command -v zstd >/dev/null || die "zstd is not installed (apt-get install zstd)"
command -v flock >/dev/null || die "flock is not installed (util-linux)"
[ -x "$ZSNAP_ZEBRAD" ] || die "no snapshot-capable zebrad at $ZSNAP_ZEBRAD (set ZSNAP_ZEBRAD)"
case "$ZSNAP_MODE" in cold|hot) : ;; *) die "ZSNAP_MODE must be cold or hot, got '$ZSNAP_MODE'";; esac

mkdir -p "$ZSNAP_DIR/snapshots" "$ZSNAP_DIR/work"

# One export at a time. A second timer firing while a big export is still
# compressing should skip, not stack.
exec 9>"$ZSNAP_DIR/.export.lock"
flock -n 9 || die "another export is already running"

cache_dir="$(docker volume inspect -f '{{.Mountpoint}}' "$ZSNAP_CHAIN_VOLUME" 2>/dev/null)" \
  || die "chain volume $ZSNAP_CHAIN_VOLUME not found (is the z3 stack on this box?)"

if [ "$ZSNAP_FORCE" != "1" ]; then
  # Wait for ready rather than sampling it once. A momentary lag past
  # READY_MAX_BLOCKS_BEHIND (testnet mints bursts) read as un-ready and cost a
  # whole 6h cycle, so this polls across the window instead of dying on one
  # observation.
  ready_attempt=1
  until curl -fsS --max-time 10 "$ZSNAP_READY_URL" >/dev/null 2>&1; do
    if [ "$ready_attempt" -ge "$ZSNAP_READY_TRIES" ]; then
      die "zebra was not ready in $ZSNAP_READY_TRIES probes over ~$((ZSNAP_READY_TRIES * ZSNAP_READY_WAIT / 60)) min ($ZSNAP_READY_URL), refusing a stale snapshot (ZSNAP_FORCE=1 overrides)"
    fi
    log "zebra not ready, probe $ready_attempt/$ZSNAP_READY_TRIES, retrying in ${ZSNAP_READY_WAIT}s (a brief lag is normal on testnet)"
    ready_attempt=$((ready_attempt + 1))
    sleep "$ZSNAP_READY_WAIT"
  done
  [ "$ready_attempt" = "1" ] || log "zebra became ready after $ready_attempt probes"

  # Peak is the raw export plus the archive being written, while all KEEP
  # existing generations are still present. Measured, not guessed: the raw
  # export is about the state size, and the new archive is sized from the
  # largest existing one (falling back to a third of the state when there is
  # none yet, which is roughly what zstd achieves on this data).
  state_kb="$(du -sk "$cache_dir" | cut -f1)"
  free_kb="$(df -Pk "$ZSNAP_DIR" | awk 'NR==2 {print $4}')"
  biggest_kb="$(find "$ZSNAP_DIR/snapshots" -maxdepth 1 -name "zsnap-$ZSNAP_NETWORK-*.tar.zst" -printf '%k\n' 2>/dev/null \
    | sort -rn | head -1)"
  archive_kb="${biggest_kb:-$((state_kb / 3))}"
  need_kb=$((state_kb + archive_kb))
  if [ "$free_kb" -lt "$need_kb" ]; then
    die "need ~$((need_kb / 1024)) MB free in $ZSNAP_DIR for the export plus its archive, have $((free_kb / 1024)) MB. Lower ZSNAP_KEEP (now $ZSNAP_KEEP) or add disk (ZSNAP_FORCE=1 overrides)"
  fi
  # Two different warnings, because the old one asked the wrong question and so
  # could not fire for the failure that was actually coming.
  #
  # It compared steady_kb against free_kb + used_kb, the filesystem TOTAL. That
  # asks "is this disk big enough in principle". The failure on our box is a disk
  # that is big enough and merely FULL: 146 GB total against a 44 GB steady state,
  # so it stayed silent while the next export was 0.5 GB from refusing. A warning
  # that predicts a refusal only when the disk could never work is a warning that
  # arrives after the operator already knows.
  #
  # HEADROOM is the one that gives lead time: how close is free to need, right now.
  headroom_kb=$((free_kb - need_kb))
  if [ "$headroom_kb" -lt "$archive_kb" ]; then
    # Name the KEEP that would fit rather than saying "lower it". Each generation
    # dropped frees one archive, so this is arithmetic the operator should not have
    # to redo at 3am.
    # Floor of 1, never 0. Recommending zero retention means deleting the thing
    # this script exists to produce, and the loop happily reached it: at KEEP=1 the
    # first version of this advised KEEP=0. Found by simulating the box AFTER taking
    # my own advice, which is the case a recommendation should always be checked
    # against.
    fits=$ZSNAP_KEEP
    while [ "$fits" -gt 1 ] && [ "$((free_kb + (ZSNAP_KEEP - fits) * archive_kb - need_kb))" -lt "$archive_kb" ]; do
      fits=$((fits - 1))
    done
    if [ "$fits" -lt "$ZSNAP_KEEP" ]; then
      advice="Set ZSNAP_KEEP=$fits to free ~$(( (ZSNAP_KEEP - fits) * archive_kb / 1024 )) MB."
    else
      # Already at the floor, or dropping generations would not buy an archive's
      # worth. Say so instead of suggesting a change that changes nothing.
      advice="ZSNAP_KEEP is already $ZSNAP_KEEP, so retention cannot buy the room: this needs more disk, or publishing so snapshots stop living here (#7)."
    fi
    log "WARNING: only ~$((headroom_kb / 1024)) MB of headroom after this export, less than one archive (~$((archive_kb / 1024)) MB). The next export may refuse. $advice"
  fi

  # Kept, because "this disk can never hold the steady state" is still worth saying,
  # it is just a different and rarer problem from running out today.
  steady_kb=$(( (ZSNAP_KEEP + 1) * archive_kb + state_kb ))
  used_kb="$(df -Pk "$ZSNAP_DIR" | awk 'NR==2 {print $3}')"
  if [ "$((free_kb + used_kb))" -lt "$steady_kb" ]; then
    log "WARNING: this filesystem cannot hold the steady state at all. $ZSNAP_KEEP generations plus one in-flight export needs ~$((steady_kb / 1024)) MB, the filesystem is ~$(((free_kb + used_kb) / 1024)) MB total."
  fi

  # Neither warning reaches anybody: both go to stdout and journald, and alerting
  # is deferred (#215). A stale latest.tar.zst that still looks healthy is the
  # symptom, and nothing pages for it.
  
fi

work=""
stopped_zebra=""
stopped_watchdog=0
cleanup() {
  # Restart order matters: zebra first (the thing users feel), watchdog after
  # (so it never observes the window as a fault to page about).
  if [ -n "$stopped_zebra" ]; then
    log "restarting zebra container $stopped_zebra"
    docker start "$stopped_zebra" >/dev/null 2>&1 \
      || log "ERROR: could not restart $stopped_zebra, the watchdog will retry"
  fi
  if [ "$stopped_watchdog" = "1" ]; then
    systemctl start "$ZSNAP_WATCHDOG_UNIT" >/dev/null 2>&1 \
      || log "ERROR: could not restart $ZSNAP_WATCHDOG_UNIT"
  fi
  rm -f "$window_marker"
  [ -n "$work" ] && rm -rf "$work"
}
trap cleanup EXIT
# A signal must still run the EXIT trap (bash skips it on unhandled signals).
trap 'exit 1' HUP INT TERM

if [ "$ZSNAP_MODE" = "cold" ]; then
  zebra="$(docker ps --filter "name=$ZSNAP_ZEBRA_MATCH" --format '{{.Names}}' | head -n1)"
  if [ -n "$zebra" ]; then
    # Marker before touching anything: if we die mid-window, `recover`
    # (ExecStopPost) reads it and puts everything back. It is pessimistic on
    # purpose, starting an already-running unit or container is a no-op.
    echo "$zebra 1" > "$window_marker"
    # The watchdog docker-starts any exited target container within its sweep
    # interval, which would put the primary back mid-export. Pause it first,
    # and refuse the window unless it is confirmed down.
    if command -v systemctl >/dev/null; then
      if systemctl is-active --quiet "$ZSNAP_WATCHDOG_UNIT"; then
        log "pausing $ZSNAP_WATCHDOG_UNIT for the maintenance window"
        systemctl stop "$ZSNAP_WATCHDOG_UNIT"
        stopped_watchdog=1
      fi
      if systemctl is-active --quiet "$ZSNAP_WATCHDOG_UNIT"; then
        die "$ZSNAP_WATCHDOG_UNIT is still active after stop, refusing to open the window"
      fi
    else
      log "no systemctl on this host, assuming no watchdog will interfere"
    fi
    log "stopping $zebra for the export window (graceful, ${ZSNAP_STOP_TIMEOUT}s)"
    docker stop -t "$ZSNAP_STOP_TIMEOUT" "$zebra" >/dev/null
    stopped_zebra="$zebra"
  else
    log "no running container matches '$ZSNAP_ZEBRA_MATCH', exporting without a window"
  fi
fi

work="$(mktemp -d "$ZSNAP_DIR/work/export.XXXXXX")"
out="$work/snapshot"

# The retry exists for hot mode: a read-only secondary open can lose a race
# with the primary's WAL rotation and fail transiently. In cold mode a retry
# just papers over a slow lock release after the container stop. Between
# attempts the out dir is wiped, export-snapshot refuses a non-empty target.
# The secondary instance's scratch dir goes under TMPDIR (zebra leaves it
# behind by design), so point TMPDIR at the workdir and the trap cleans it.
attempt=1
while :; do
  rm -rf "$out"
  log "exporting $ZSNAP_NETWORK state from $ZSNAP_CHAIN_VOLUME (mode=$ZSNAP_MODE, attempt $attempt/$ZSNAP_RETRIES)"
  if TMPDIR="$work" "$ZSNAP_ZEBRAD" export-snapshot "$out" \
       --cache-dir "$cache_dir" --network "$ZSNAP_NETWORK" \
       | tee "$work/export.log"; then
    break
  fi
  [ "$attempt" -lt "$ZSNAP_RETRIES" ] \
    || die "export failed $ZSNAP_RETRIES times, giving up (zebra is restarted by the exit trap)"
  attempt=$((attempt + 1))
  log "export failed, retrying in ${ZSNAP_RETRY_WAIT}s"
  sleep "$ZSNAP_RETRY_WAIT"
done

height="$(awk -F': *' '/^tip height:/ {print $2}' "$work/export.log")"
manifest_hash="$(awk -F': *' '/^manifest hash:/ {print $2}' "$work/export.log")"
[ -n "$height" ] && [ -n "$manifest_hash" ] \
  || die "could not parse tip height / manifest hash from export output"

# End the window before compression: zstd can take minutes and needs nothing
# from the database. The trap stays armed as a no-op after this.
if [ -n "$stopped_zebra" ]; then
  log "export done, restarting zebra container $stopped_zebra"
  docker start "$stopped_zebra" >/dev/null
  stopped_zebra=""
fi
if [ "$stopped_watchdog" = "1" ]; then
  systemctl start "$ZSNAP_WATCHDOG_UNIT"
  stopped_watchdog=0
fi

name="zsnap-$ZSNAP_NETWORK-$height-${manifest_hash:0:12}"
archive="$ZSNAP_DIR/snapshots/$name.tar.zst"

log "compressing to $archive"
tar -C "$work" -cf - snapshot | zstd -T0 -q -o "$archive.part"
mv "$archive.part" "$archive"
echo "$manifest_hash" > "$archive.manifest-hash"

# VERIFY BEFORE PUBLISHING, AND THE ORDER IS THE POINT.
#
# This used to repoint `latest` and then rotate, both before anything read the archive
# back. So a snapshot truncated by a full disk, and this box has hit 100% disk once
# already, would become `latest` and could evict the last GOOD snapshot on the way out.
# The failure would then surface at import, on the day someone is rebuilding a box,
# which is the worst possible moment to discover it.
#
# What is checked is what zsnap-import will demand: every chunk present with its listed
# size and content hash, and a manifest whose canonical hash is the value in the sidecar.
# Verifying the consumer's contract here means we never publish something the importer
# will reject. verify_snapshot is defined near the top, with the long note on why its
# first version could never pass.

if ! verify_snapshot "$archive" "$manifest_hash"; then
  # Kept, renamed, NOT published, and AT MOST ONE.
  #
  # My first version kept every failure, and App found the loop that creates: rotation
  # globs *.tar.zst, so a .unverified is never swept. The commonest cause of a bad
  # snapshot here is a full disk, so a disk-full event would permanently consume disk
  # with the evidence OF the disk-full event, making the next one likelier and its
  # evidence file bigger. A feedback loop, running on a timer, on multi-GB files.
  #
  # Evidence beats tidiness was right in isolation and wrong in context. One is enough:
  # the second failure in a row is almost always the same failure, and the note below
  # survives even when the payload is dropped.
  rm -f "$ZSNAP_DIR/snapshots/"*.tar.zst.unverified "$ZSNAP_DIR/snapshots/"*.unverified.txt 2>/dev/null || true
  mv "$archive" "$archive.unverified" 2>/dev/null || true
  rm -f "$archive.manifest-hash"
  # A note, because when the cause IS a full disk the payload teaches you nothing the
  # size and timestamp do not, and this is what remains if we ever stop keeping payloads.
  {
    echo "failed: $(date -u +%FT%TZ)"
    echo "height: $height"
    echo "zebrad reported manifest hash: $manifest_hash"
    echo "bytes: $(wc -c < "$archive.unverified" 2>/dev/null || echo unknown)"
    echo "failed check: ${VERIFY_FAIL:-unknown}"
  } > "$archive.unverified.txt" 2>/dev/null || true
  die "the snapshot this run produced did not verify, kept as $(basename "$archive").unverified, latest is unchanged"
fi

# Only now is it safe to call this the newest good snapshot.
ln -sfn "$name.tar.zst" "$ZSNAP_DIR/snapshots/latest.tar.zst"
ln -sfn "$name.tar.zst.manifest-hash" "$ZSNAP_DIR/snapshots/latest.manifest-hash"

# Rotate: newest ZSNAP_KEEP archives stay, older ones and their sidecars go.
find "$ZSNAP_DIR/snapshots" -maxdepth 1 -name "zsnap-$ZSNAP_NETWORK-*.tar.zst" -printf '%T@ %p\n' \
  | sort -rn | cut -d' ' -f2- | tail -n +"$((ZSNAP_KEEP + 1))" \
  | while read -r old; do
      log "rotating out $(basename "$old")"
      rm -f "$old" "$old.manifest-hash"
    done

log "done: height $height, manifest hash $manifest_hash, $(du -h "$archive" | cut -f1) on disk, verified"

if [ -n "$ZSNAP_UPLOAD_CMD" ]; then
  log "running upload hook"
  $ZSNAP_UPLOAD_CMD "$archive" || log "upload hook failed (snapshot is still good locally)"
fi

# PUBLISH, AND ONLY EVER FROM HERE (#7).
#
# This line sits AFTER verification and after rotation on purpose. zsnap-publish copies
# whatever it is pointed at, and the directory above also holds `.unverified` archives -
# the ones this script's own check rejected. Publishing from there would hand a stranger
# rebuilding a box exactly the file we refused to trust. Reaching this line means the
# archive verified, so the set that can be published is the set that passed.
#
# Failure is logged and NOT fatal. A snapshot that exists locally but is not published is
# a smaller problem than a run that reports failure and makes an operator go looking for a
# broken export. The next run republishes.
if [ -n "${ZSNAP_PUBLISH_CMD:-}" ] && [ -n "${ZSNAP_PUBLISH_BASE:-}" ]; then
  log "publishing $(basename "$archive")"
  "$(dirname "$0")/zsnap-publish.sh" "$archive" \
    || log "publish failed (the snapshot is verified and still here; the next run retries)"
fi
