#!/usr/bin/env bash
# Restores a faucet backup made by backup.sh: the wallet (encryption
# identity + wallet.db) into the zallet volume, and the rate-limit ledger
# into the faucet volume when the archive has one.
#
# Usage:
#   restore-backup.sh [archive.tar.gz.gpg]     default: newest local archive
#
# Needs BACKUP_PASSPHRASE (same env file as backup.sh). Three refusals keep
# this from making a bad day worse, since restoring wallet keys over a live
# or newer wallet is how funds get lost:
#   - refuses while a zallet or faucet container is running (stop the stack)
#   - refuses to overwrite an existing wallet.db or faucet.db unless FORCE=1
#   - refuses an archive whose inner MANIFEST hashes do not match
#
# After a restore, bring the stack back up (deploy.sh or compose up -d).
# Zallet re-scans from its stored wallet birthday on its own.
set -euo pipefail

# shellcheck disable=SC1091
[ -f /etc/faucet/backup.env ] && . /etc/faucet/backup.env

BACKUP_NETWORK="${BACKUP_NETWORK:-testnet}"
BACKUP_ZALLET_VOLUME="${BACKUP_ZALLET_VOLUME:-z3-${BACKUP_NETWORK}-zallet}"
BACKUP_FAUCET_VOLUME="${BACKUP_FAUCET_VOLUME:-zcash-faucet_faucet_data}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/faucet-backups}"
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-}"
FORCE="${FORCE:-0}"

log() { echo "$(date -u +%FT%TZ) faucet-restore: $*"; }
die() { log "ERROR: $*"; exit 1; }

command -v gpg >/dev/null    || die "gpg is not installed"
command -v docker >/dev/null || die "docker is not installed"
[ -n "$BACKUP_PASSPHRASE" ] || die "BACKUP_PASSPHRASE is not set, cannot decrypt"

archive="${1:-}"
if [ -z "$archive" ]; then
  archive="$(find "$BACKUP_DIR/archives" -maxdepth 1 -name "faucet-backup-$BACKUP_NETWORK-*.tar.gz.gpg" -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)"
  [ -n "$archive" ] || die "no archive given and none found in $BACKUP_DIR/archives"
fi
[ -f "$archive" ] || die "no such archive: $archive"
log "restoring from $(basename "$archive")"

# Both services keep their dbs open, restoring underneath them corrupts the
# very thing being restored. Container names follow the watchdog convention.
for name in zallet faucet-web faucet; do
  running="$(docker ps --filter "name=$name" --format '{{.Names}}' | head -n1)"
  [ -z "$running" ] || die "container $running is running, stop the stack before restoring"
done

# Transport integrity, when the sidecar traveled with the archive.
sidecar="${archive%.tar.gz.gpg}.sha256"
if [ -f "$sidecar" ]; then
  echo "$(cat "$sidecar")  $archive" | sha256sum -c --quiet - \
    || die "archive does not match its .sha256 sidecar, refusing"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/faucet-restore.XXXXXX")"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

gpg --batch --quiet --decrypt --passphrase-fd 3 3<<<"$BACKUP_PASSPHRASE" "$archive" \
  | tar -xzf - -C "$work"
stage="$work/faucet-backup"
[ -f "$stage/MANIFEST" ] || die "archive has no MANIFEST, not a faucet backup"
[ -f "$stage/wallet.db" ] && [ -f "$stage/encryption-identity.txt" ] \
  || die "archive is missing wallet files, refusing"

# Content integrity: the manifest hashes were computed pre-encryption.
(cd "$stage" && grep -E '^[0-9a-f]{64} ' MANIFEST | sha256sum -c --quiet -) \
  || die "decrypted contents do not match the archive MANIFEST, refusing"

prep_volume() { # $1 volume, echoes its mountpoint (creating the volume if absent)
  docker volume inspect "$1" >/dev/null 2>&1 || docker volume create "$1" >/dev/null
  docker volume inspect -f '{{.Mountpoint}}' "$1"
}

# Refuse BEFORE writing anything. A per-file check that fails halfway would
# leave a freshly restored identity next to the old wallet.db, which is the
# exact mismatched-keys state the refusal exists to prevent. All destinations
# are checked up front, then all writes happen.
zallet_dir="$(prep_volume "$BACKUP_ZALLET_VOLUME")"
targets=("$zallet_dir/encryption-identity.txt" "$zallet_dir/wallet.db")
faucet_dir=""
if [ -f "$stage/faucet.db" ]; then
  faucet_dir="$(prep_volume "$BACKUP_FAUCET_VOLUME")"
  targets+=("$faucet_dir/faucet.db")
fi
if [ "$FORCE" != "1" ]; then
  for t in "${targets[@]}"; do
    [ ! -f "$t" ] \
      || die "$t already exists, refusing to overwrite (nothing was written; FORCE=1 if you really mean it)"
  done
fi

install_file() { # $1 src, $2 dest, $3 owner (uid:gid or "keep")
  install -m 600 "$1" "$2"
  if [ "$3" = "keep" ]; then
    # Match whatever owns the volume root, docker seeded it from the image.
    chown --reference="$(dirname "$2")" "$2"
  else
    chown "$3" "$2"
  fi
  log "restored $(basename "$2") into $(dirname "$2")"
}

# zallet runs as uid 1000 (z3 contract).
install_file "$stage/encryption-identity.txt" "$zallet_dir/encryption-identity.txt" 1000:1000
install_file "$stage/wallet.db"               "$zallet_dir/wallet.db"               1000:1000
if [ -n "$faucet_dir" ]; then
  install_file "$stage/faucet.db" "$faucet_dir/faucet.db" keep
else
  log "archive has no ledger, wallet-only restore"
fi

log "done, bring the stack back up (deploy.sh or docker compose up -d)"
