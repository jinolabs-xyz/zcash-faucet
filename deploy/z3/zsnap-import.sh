#!/usr/bin/env bash
# Boot-time snapshot restore for a fresh box (issue #7, "zsnap").
#
# Seeds the z3 chain volume from a zsnap snapshot BEFORE zebra ever starts, so
# a rebuilt box serves in minutes instead of resyncing for a day. faucet-up
# calls this ahead of deploy.sh on every boot. It is a quiet no-op unless both
# hold: a snapshot source is configured, and the chain volume has no state yet.
# Re-running it on a healthy box does nothing, which is what makes it safe to
# leave wired into the boot path.
#
# The source, first one wins:
#   $1                       explicit path or URL
#   $ZSNAP_SOURCE            same, from the environment
#   /etc/zsnap-restore-url   written by cloud-init (comments and blanks ignored)
#
# Accepted forms:
#   /path/to/dir             an uncompressed export (contains MANIFEST.json)
#   /path/or/url.tar.zst     a zsnap archive, local or http(s)
#   http(s)://base/url       a directory-style URL served as <url>/MANIFEST.json
#                            and <url>/chunks/..., handed to import-snapshot
#                            --url (resumable, rerun to continue)
#
# Verification is zebrad's, not ours: import-snapshot checks every chunk
# against the manifest, and authenticates the manifest against --expect-hash
# (taken from ZSNAP_EXPECT_HASH or the archive's .manifest-hash sidecar) or a
# hash embedded in the binary. With neither it refuses, unless you set
# ZSNAP_ALLOW_UNVERIFIED=1 for a snapshot you exported yourself.
#
# On any failure the half-written state is removed, so zebra falls back to a
# normal full sync instead of opening garbage. Logs go to stdout for journald.
set -euo pipefail

# Shared config, same file the systemd units load. Lets cloud-init configure
# everything (snapshot URL, expect hash, binary URL) in one place.
# shellcheck disable=SC1091
[ -f /etc/faucet/zsnap.env ] && . /etc/faucet/zsnap.env

ZSNAP_NETWORK="${ZSNAP_NETWORK:-testnet}"
ZSNAP_ZEBRAD="${ZSNAP_ZEBRAD:-/opt/zebrad-miner}"
ZSNAP_ZEBRAD_URL="${ZSNAP_ZEBRAD_URL:-}"    # fetch the binary from here if absent
ZSNAP_CHAIN_VOLUME="${ZSNAP_CHAIN_VOLUME:-z3-${ZSNAP_NETWORK}-chain}"
ZSNAP_DIR="${ZSNAP_DIR:-/var/lib/zsnap}"
ZSNAP_EXPECT_HASH="${ZSNAP_EXPECT_HASH:-}"
ZSNAP_ALLOW_UNVERIFIED="${ZSNAP_ALLOW_UNVERIFIED:-0}"
ZSNAP_SOURCE_FILE="${ZSNAP_SOURCE_FILE:-/etc/zsnap-restore-url}"

log() { echo "$(date -u +%FT%TZ) zsnap-import: $*"; }
die() { log "ERROR: $*"; exit 1; }

source="${1:-${ZSNAP_SOURCE:-}}"
if [ -z "$source" ] && [ -f "$ZSNAP_SOURCE_FILE" ]; then
  source="$(grep -v '^[[:space:]]*#' "$ZSNAP_SOURCE_FILE" | grep -m1 . | tr -d '[:space:]')" || true
fi
if [ -z "$source" ]; then
  log "no snapshot source configured, nothing to restore"
  exit 0
fi

command -v docker >/dev/null || die "docker is not installed yet"

# A fresh box has no snapshot-capable zebrad. Fetch it when a URL is
# configured, otherwise fail here with a pointer instead of half-restoring.
if [ ! -x "$ZSNAP_ZEBRAD" ] && [ -n "$ZSNAP_ZEBRAD_URL" ]; then
  log "fetching snapshot-capable zebrad from $ZSNAP_ZEBRAD_URL"
  curl -fL --retry 3 -o "$ZSNAP_ZEBRAD.part" "$ZSNAP_ZEBRAD_URL"
  chmod +x "$ZSNAP_ZEBRAD.part"
  mv "$ZSNAP_ZEBRAD.part" "$ZSNAP_ZEBRAD"
fi
[ -x "$ZSNAP_ZEBRAD" ] \
  || die "no snapshot-capable zebrad at $ZSNAP_ZEBRAD (set ZSNAP_ZEBRAD or ZSNAP_ZEBRAD_URL, see SNAPSHOTS.md)"

# Never touch a volume that already has state. That is the idempotence rule
# that makes this safe on every boot, not just the first.
if docker volume inspect "$ZSNAP_CHAIN_VOLUME" >/dev/null 2>&1; then
  cache_dir="$(docker volume inspect -f '{{.Mountpoint}}' "$ZSNAP_CHAIN_VOLUME")"
  if [ -d "$cache_dir/state" ] && [ -n "$(ls -A "$cache_dir/state" 2>/dev/null)" ]; then
    log "chain state already exists in $ZSNAP_CHAIN_VOLUME, nothing to do"
    exit 0
  fi
else
  # Pre-creating the named volume is fine: z3's compose names it explicitly,
  # so compose adopts the existing one instead of making its own.
  docker volume create "$ZSNAP_CHAIN_VOLUME" >/dev/null
  cache_dir="$(docker volume inspect -f '{{.Mountpoint}}' "$ZSNAP_CHAIN_VOLUME")"
fi

mkdir -p "$ZSNAP_DIR/work"
work="$(mktemp -d "$ZSNAP_DIR/work/import.XXXXXX")"
cleanup() {
  rm -rf "$work"
  # import-snapshot is atomic: it builds the db in a zsnap-import-* tempdir
  # inside the cache dir and renames it into place only after every check
  # passes, so a failure can never leave partial state where zebra looks.
  # What a hard kill CAN leave is that tempdir, so sweep it here.
  if [ "${import_ok:-0}" != "1" ] && [ -n "${cache_dir:-}" ]; then
    rm -rf "$cache_dir"/zsnap-import-*
  fi
}
trap cleanup EXIT

fetch_sidecar() { # $1 = sidecar path or url, best effort
  case "$1" in
    http://*|https://*) curl -fsSL --max-time 60 "$1" 2>/dev/null | tr -d '[:space:]' ;;
    *) [ -f "$1" ] && tr -d '[:space:]' < "$1" ;;
  esac
}

# Resolves one candidate and imports it. Returns nonzero on any failure so the
# caller can try the next generation instead of giving up.
try_candidate() { # $1 = archive path, directory, or url
  local cand="$1" expect_hash="$ZSNAP_EXPECT_HASH" snapshot_dir="" manifest
  local attempt_dir url_arg=() verify_args=()
  attempt_dir="$(mktemp -d "$work/attempt.XXXXXX")" || return 1

  case "$cand" in
    http://*.tar.zst|https://*.tar.zst)
      command -v zstd >/dev/null || { log "zstd is not installed"; return 1; }
      log "downloading $cand"
      curl -fL -C - --retry 3 -o "$attempt_dir/snapshot.tar.zst" "$cand" || return 1
      [ -n "$expect_hash" ] || expect_hash="$(fetch_sidecar "$cand.manifest-hash" || true)"
      cand="$attempt_dir/snapshot.tar.zst"
      ;;
  esac

  case "$cand" in
    *.tar.zst)
      command -v zstd >/dev/null || { log "zstd is not installed"; return 1; }
      [ -f "$cand" ] || { log "no such archive: $cand"; return 1; }
      [ -n "$expect_hash" ] || expect_hash="$(fetch_sidecar "$cand.manifest-hash" || true)"
      # Transport check first: a truncated download is cheaper to catch here
      # than inside zebrad.
      local sha_file="$cand.sha256"
      if [ -f "$sha_file" ]; then
        if ! echo "$(cat "$sha_file")  $cand" | sha256sum -c --quiet - 2>/dev/null; then
          log "sha256 mismatch on $(basename "$cand"), it is corrupt or truncated"
          return 1
        fi
      fi
      log "unpacking $(basename "$cand")"
      zstd -dc "$cand" | tar -C "$attempt_dir" -xf - || { log "could not unpack $(basename "$cand")"; return 1; }
      manifest="$(find "$attempt_dir" -name MANIFEST.json -print -quit)"
      [ -n "$manifest" ] || { log "no MANIFEST.json inside $(basename "$cand")"; return 1; }
      snapshot_dir="$(dirname "$manifest")"
      ;;
    http://*|https://*)
      snapshot_dir="$attempt_dir/snapshot"
      url_arg=(--url "$cand")
      ;;
    *)
      [ -f "$cand/MANIFEST.json" ] || { log "$cand is not a snapshot directory"; return 1; }
      snapshot_dir="$cand"
      ;;
  esac

  if [ -n "$expect_hash" ]; then
    verify_args=(--expect-hash "$expect_hash")
  elif [ "$ZSNAP_ALLOW_UNVERIFIED" = "1" ]; then
    verify_args=(--allow-unverified)
    log "WARNING: importing without authentication (ZSNAP_ALLOW_UNVERIFIED=1)"
  fi

  log "importing into $ZSNAP_CHAIN_VOLUME ($cache_dir)"
  "$ZSNAP_ZEBRAD" import-snapshot "$snapshot_dir" "${url_arg[@]}" "${verify_args[@]}" \
    --cache-dir "$cache_dir" --network "$ZSNAP_NETWORK" || return 1
  return 0
}

# The generations are fallback layers, so build the list newest to oldest.
# What the source IS decides, not how it arrived: a directory of archives is a
# fallback chain even when named explicitly, while a single archive is one
# candidate even when it came from config.
candidates=()
if [ -d "$source" ] && [ -f "$source/MANIFEST.json" ]; then
  candidates=("$source")                       # already an unpacked snapshot
elif [ -d "$source" ]; then
  while read -r f; do [ -n "$f" ] && candidates+=("$f"); done < <(
    find "$source" -maxdepth 1 -name "zsnap-$ZSNAP_NETWORK-*.tar.zst" -printf '%T@ %p\n' 2>/dev/null \
      | sort -rn | cut -d' ' -f2-)
  [ "${#candidates[@]}" -gt 0 ] \
    || die "$source holds no zsnap-$ZSNAP_NETWORK-*.tar.zst archives"
elif printf '%s' "$source" | grep -q '^https\?://.*latest-.*\.txt$'; then
  # A published pointer lists every generation; take them in its order.
  base="${source%/*}"
  while read -r f; do [ -n "$f" ] && candidates+=("$base/$f"); done < <(
    curl -fsSL --max-time 60 "$source" 2>/dev/null | sed -n 's/^file[0-9]*=//p')
  [ "${#candidates[@]}" -gt 0 ] || candidates=("$source")
else
  candidates=("$source")
fi

log "${#candidates[@]} candidate(s) to try, newest first"
gen=0
for cand in "${candidates[@]}"; do
  gen=$((gen + 1))
  log "generation $gen/${#candidates[@]}: $(basename "$cand")"
  if try_candidate "$cand"; then
    import_ok=1
    break
  fi
  # Loud on purpose: a silently skipped generation hides a corrupt archive.
  log "GENERATION $gen FAILED: $(basename "$cand"). Trying the next older one."
  rm -rf "$cache_dir"/zsnap-import-* 2>/dev/null || true
done

if [ "${import_ok:-0}" != "1" ]; then
  log "ERROR: all ${#candidates[@]} generation(s) failed to import."
  log "Zebra will sync from genesis, which is correct but slow. Investigate the archives:"
  log "  every one failed its checksum, its manifest verification, or the import itself."
  exit 1
fi

log "done, zebra will start from the snapshot tip and sync the remainder"
