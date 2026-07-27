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

expect_hash="$ZSNAP_EXPECT_HASH"
snapshot_dir=""
url_arg=()

fetch_sidecar() { # $1 = sidecar path or url, best effort
  case "$1" in
    http://*|https://*) curl -fsSL --max-time 60 "$1" 2>/dev/null | tr -d '[:space:]' ;;
    *) [ -f "$1" ] && tr -d '[:space:]' < "$1" ;;
  esac
}

# A .tar.zst URL is downloaded first, then handled like a local archive.
case "$source" in
  http://*.tar.zst|https://*.tar.zst)
    command -v zstd >/dev/null || die "zstd is not installed (apt-get install zstd)"
    log "downloading $source"
    # -C - resumes a partial download if this script is rerun after a drop.
    curl -fL -C - --retry 3 -o "$work/snapshot.tar.zst" "$source"
    [ -n "$expect_hash" ] || expect_hash="$(fetch_sidecar "$source.manifest-hash" || true)"
    source="$work/snapshot.tar.zst"
    ;;
esac

case "$source" in
  *.tar.zst)
    command -v zstd >/dev/null || die "zstd is not installed (apt-get install zstd)"
    [ -f "$source" ] || die "no such archive: $source"
    [ -n "$expect_hash" ] || expect_hash="$(fetch_sidecar "$source.manifest-hash" || true)"
    log "unpacking $(basename "$source")"
    zstd -dc "$source" | tar -C "$work" -xf -
    manifest="$(find "$work" -name MANIFEST.json -print -quit)"
    [ -n "$manifest" ] || die "archive has no MANIFEST.json, not a zsnap snapshot"
    snapshot_dir="$(dirname "$manifest")"
    ;;
  http://*|https://*)
    # Directory-style URL: let zebrad do the (resumable, verified) download.
    snapshot_dir="$work/snapshot"
    url_arg=(--url "$source")
    ;;
  *)
    [ -f "$source/MANIFEST.json" ] || die "$source is not a snapshot directory (no MANIFEST.json)"
    snapshot_dir="$source"
    ;;
esac

verify_args=()
if [ -n "$expect_hash" ]; then
  verify_args=(--expect-hash "$expect_hash")
elif [ "$ZSNAP_ALLOW_UNVERIFIED" = "1" ]; then
  verify_args=(--allow-unverified)
  log "WARNING: importing without authentication (ZSNAP_ALLOW_UNVERIFIED=1)"
fi
# With neither, zebrad falls back to its embedded trusted hash for this
# network and height, and refuses if there is none. That refusal is correct.

log "importing into $ZSNAP_CHAIN_VOLUME ($cache_dir)"
"$ZSNAP_ZEBRAD" import-snapshot "$snapshot_dir" "${url_arg[@]}" "${verify_args[@]}" \
  --cache-dir "$cache_dir" --network "$ZSNAP_NETWORK"
import_ok=1

# Files were written as root. The zebra container's entrypoint chowns its
# cache dir to the zebra user before dropping privileges (z3 grants it CHOWN
# for exactly this), so ownership sorts itself out on first start.
log "done, zebra will start from the snapshot tip and sync the remainder"
