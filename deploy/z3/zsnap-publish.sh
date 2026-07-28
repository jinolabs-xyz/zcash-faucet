#!/usr/bin/env bash
# Publishes a zsnap snapshot somewhere a dead box's replacement can fetch it.
#
# ZSNAP_UPLOAD_CMD already lets the export copy an archive off-box, but a pile
# of timestamped archives in a bucket is not a recovery path: a fresh box has
# to be told which one to take and what hash to trust, and whoever set it up
# is the one person who knows. This publishes the whole set a stranger needs:
#
#   zsnap-<net>-<height>-<hash12>.tar.zst        the snapshot
#   zsnap-<net>-<height>-<hash12>.tar.zst.sha256 transport checksum
#   <same>.manifest-hash                         the snapshot's identity
#   latest-<net>.txt                             pointer: filename, height, hash
#
# `latest-<net>.txt` is what makes this usable. It is three lines of plain
# text, so a fresh box (or a person) can read it with curl and know exactly
# what to download and what --expect-hash to pass.
#
# Usage:
#   zsnap-publish.sh                 publish the newest local snapshot
#   zsnap-publish.sh <archive>       publish a specific one
#   zsnap-publish.sh --dry-run       print what would be uploaded, upload nothing
#
# The upload itself is your command, because every host differs:
#   ZSNAP_PUBLISH_CMD='rclone copyto'
#   ZSNAP_PUBLISH_CMD='s3cmd put'
# It is invoked as: $ZSNAP_PUBLISH_CMD <local-file> <remote-base>/<filename>
#
# Publishing is not sensitive: chain state is public data. The manifest hash
# is what makes a downloaded snapshot trustworthy, so it travels with the
# archive AND belongs in your team notes (see SNAPSHOTS.md).
set -uo pipefail

# shellcheck disable=SC1091
[ -f /etc/faucet/zsnap.env ] && . /etc/faucet/zsnap.env

ZSNAP_NETWORK="${ZSNAP_NETWORK:-testnet}"
ZSNAP_DIR="${ZSNAP_DIR:-/var/lib/zsnap}"
ZSNAP_PUBLISH_CMD="${ZSNAP_PUBLISH_CMD:-}"
ZSNAP_PUBLISH_BASE="${ZSNAP_PUBLISH_BASE:-}"   # e.g. linode:zcash-faucet-snapshots
DRY_RUN=0

log() { echo "$(date -u +%FT%TZ) zsnap-publish: $*"; }
die() { log "ERROR: $*"; exit 1; }

archive=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) die "unknown option $arg (usage: zsnap-publish.sh [--dry-run] [archive])" ;;
    *) archive="$arg" ;;
  esac
done

if [ "$DRY_RUN" != "1" ]; then
  [ -n "$ZSNAP_PUBLISH_CMD" ] || die "ZSNAP_PUBLISH_CMD is not set (see SNAPSHOTS.md), nothing would be uploaded"
  [ -n "$ZSNAP_PUBLISH_BASE" ] || die "ZSNAP_PUBLISH_BASE is not set (the remote to publish into)"
fi

# Newest archive by mtime when none was named.
if [ -z "$archive" ]; then
  archive="$(find "$ZSNAP_DIR/snapshots" -maxdepth 1 -name "zsnap-$ZSNAP_NETWORK-*.tar.zst" -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)"
  [ -n "$archive" ] || die "no $ZSNAP_NETWORK snapshot found in $ZSNAP_DIR/snapshots (run an export first)"
fi
[ -f "$archive" ] || die "no such archive: $archive"

name="$(basename "$archive")"
hash_file="$archive.manifest-hash"
[ -f "$hash_file" ] \
  || die "$name has no .manifest-hash sidecar, publishing it would give importers nothing to verify against"
manifest_hash="$(tr -d '[:space:]' < "$hash_file")"
[ -n "$manifest_hash" ] || die "$hash_file is empty"

# Height is in the filename the export chose: zsnap-<net>-<height>-<hash12>.
height="$(printf '%s' "$name" | sed -n "s/^zsnap-$ZSNAP_NETWORK-\([0-9]\+\)-.*/\1/p")"
[ -n "$height" ] || die "could not read a height out of the filename $name"

# Transport checksum, so a truncated download is caught before zebrad is
# asked to make sense of it. Separate from the manifest hash, which is about
# authenticity of the contents rather than integrity of the transfer.
work="$(mktemp -d "${TMPDIR:-/tmp}/zsnap-publish.XXXXXX")"
trap 'rm -rf "$work"' EXIT
sha_file="$work/$name.sha256"
sha256sum "$archive" | awk '{print $1}' > "$sha_file"

# The pointer file. Deliberately plain text and self-describing: someone
# rebuilding a dead box at 3am should not have to parse anything.
# Lists every local generation, newest first, so an off-box restorer gets the
# same fallback chain the box has. file=/file2=/file3= are read in order.
pointer="$work/latest-$ZSNAP_NETWORK.txt"
{
  echo "file=$name"
  echo "height=$height"
  echo "manifest_hash=$manifest_hash"
  echo "sha256=$(cat "$sha_file")"
  echo "published=$(date -u +%FT%TZ)"
  gen=1
  while read -r older; do
    [ -n "$older" ] || continue
    [ "$(basename "$older")" = "$name" ] && continue
    gen=$((gen + 1))
    echo "file${gen}=$(basename "$older")"
    [ -f "$older.manifest-hash" ] \
      && echo "manifest_hash${gen}=$(tr -d '[:space:]' < "$older.manifest-hash")"
  done < <(find "$ZSNAP_DIR/snapshots" -maxdepth 1 -name "zsnap-$ZSNAP_NETWORK-*.tar.zst" -printf '%T@ %p\n' 2>/dev/null \
             | sort -rn | cut -d' ' -f2-)
} > "$pointer"

log "publishing $name (height $height)"
log "  manifest hash: $manifest_hash"
log "  size:          $(du -h "$archive" | cut -f1)"

upload() { # $1 local file
  local remote
  remote="$ZSNAP_PUBLISH_BASE/$(basename "$1")"
  if [ "$DRY_RUN" = "1" ]; then
    log "  would upload $(basename "$1") -> ${ZSNAP_PUBLISH_BASE:-<unset>}/$(basename "$1")"
    return 0
  fi
  log "  uploading $(basename "$1")"
  # Unquoted on purpose: the command may carry its own arguments.
  # shellcheck disable=SC2086
  $ZSNAP_PUBLISH_CMD "$1" "$remote" || return 1
}

# Order matters. The archive and its hashes go up FIRST, and the pointer only
# after they all land, so a reader that sees a new pointer can rely on what it
# names being there. A pointer to a half-uploaded archive is worse than a
# stale pointer.
upload "$archive"   || die "uploading the archive failed, nothing was published"
upload "$hash_file" || die "uploading the manifest hash failed, the archive is up but unusable, rerun this"
upload "$sha_file"  || die "uploading the checksum failed, rerun this"
upload "$pointer"   || die "uploading the pointer failed, the snapshot is up but nothing points at it, rerun this"

if [ "$DRY_RUN" = "1" ]; then
  log "dry run, nothing uploaded. Pointer would read:"
  sed 's/^/    /' "$pointer"
  exit 0
fi

log "published. A fresh box restores with:"
log "  curl -fsS <public-base>/latest-$ZSNAP_NETWORK.txt        # read file= and manifest_hash="
log "  ZSNAP_EXPECT_HASH=$manifest_hash \\"
log "    /opt/faucet/zsnap-import.sh <public-base>/$name"
