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
  # Warn, do not refuse, when the steady state will not fit once this run
  # rotates: the export still helps today and the operator needs the number.
  steady_kb=$(( (ZSNAP_KEEP + 1) * archive_kb + state_kb ))
  used_kb="$(df -Pk "$ZSNAP_DIR" | awk 'NR==2 {print $3}')"
  if [ "$((free_kb + used_kb))" -lt "$steady_kb" ]; then
    log "WARNING: this filesystem cannot hold the steady state. $ZSNAP_KEEP generations plus one in-flight export needs ~$((steady_kb / 1024)) MB, the filesystem is ~$(((free_kb + used_kb) / 1024)) MB. Rotation will keep working but a future export may refuse."
  fi
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
ln -sfn "$name.tar.zst" "$ZSNAP_DIR/snapshots/latest.tar.zst"
ln -sfn "$name.tar.zst.manifest-hash" "$ZSNAP_DIR/snapshots/latest.manifest-hash"

# Rotate: newest ZSNAP_KEEP archives stay, older ones and their sidecars go.
find "$ZSNAP_DIR/snapshots" -maxdepth 1 -name "zsnap-$ZSNAP_NETWORK-*.tar.zst" -printf '%T@ %p\n' \
  | sort -rn | cut -d' ' -f2- | tail -n +"$((ZSNAP_KEEP + 1))" \
  | while read -r old; do
      log "rotating out $(basename "$old")"
      rm -f "$old" "$old.manifest-hash"
    done

log "done: height $height, manifest hash $manifest_hash, $(du -h "$archive" | cut -f1) on disk"

if [ -n "$ZSNAP_UPLOAD_CMD" ]; then
  log "running upload hook"
  $ZSNAP_UPLOAD_CMD "$archive" || log "upload hook failed (snapshot is still good locally)"
fi
