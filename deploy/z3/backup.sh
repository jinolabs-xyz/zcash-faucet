#!/usr/bin/env bash
# Scheduled backup of the faucet's irreplaceable state. Chain state is
# re-syncable and zsnap covers it, but two things on this box exist nowhere
# else: the wallet (age encryption identity + wallet.db, together they ARE
# the faucet's funds) and the rate-limit ledger (cooldown and daily-cap
# history in faucet.db). A lost disk without these means lost keys.
#
# What one run produces in $BACKUP_DIR/archives:
#   faucet-backup-<net>-<utc-stamp>.tar.gz.gpg   AES256, symmetric
#   faucet-backup-<net>-<utc-stamp>.sha256       transport checksum
#
# The passphrase comes from BACKUP_PASSPHRASE in /etc/faucet/backup.env and
# the script refuses to write anything without it: the archive bundles the
# encryption identity, i.e. the key that decrypts the wallet, so plaintext
# at rest is never acceptable. Keep the passphrase OFF this box as well
# (see BACKUPS.md), an encrypted backup you cannot decrypt is a dead letter.
#
# Databases are copied with sqlite's online backup API (via python3, already
# a deploy.sh dependency), not cp: both zallet and the faucet keep their dbs
# open, and copying a live sqlite file can tear mid-checkpoint. The identity
# file is static after wallet init, a plain copy is fine there.
#
# The zaino/ indexer dir in the zallet volume is deliberately excluded, it
# is re-syncable chain data and dwarfs everything worth keeping.
#
# Everything is env-configurable, logs go to stdout for journald. Run it
# under faucet-backup.timer, or by hand for a one-off before risky work.
set -euo pipefail

# shellcheck disable=SC1091
[ -f /etc/faucet/backup.env ] && . /etc/faucet/backup.env

BACKUP_NETWORK="${BACKUP_NETWORK:-testnet}"
BACKUP_ZALLET_VOLUME="${BACKUP_ZALLET_VOLUME:-z3-${BACKUP_NETWORK}-zallet}"
BACKUP_FAUCET_VOLUME="${BACKUP_FAUCET_VOLUME:-zcash-faucet_faucet_data}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/faucet-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"              # archives kept after a new one lands
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-}"    # required, see header
BACKUP_UPLOAD_CMD="${BACKUP_UPLOAD_CMD:-}"    # optional: run <cmd> <archive> after backup

log() { echo "$(date -u +%FT%TZ) faucet-backup: $*"; }
die() { log "ERROR: $*"; exit 1; }

command -v gpg >/dev/null     || die "gpg is not installed"
command -v python3 >/dev/null || die "python3 is not installed"
command -v flock >/dev/null   || die "flock is not installed (util-linux)"
command -v docker >/dev/null  || die "docker is not installed"
[ -n "$BACKUP_PASSPHRASE" ] \
  || die "BACKUP_PASSPHRASE is not set (/etc/faucet/backup.env), refusing an unencrypted backup"

mkdir -p "$BACKUP_DIR/archives" "$BACKUP_DIR/work"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/archives"

exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || die "another backup is already running"

# The wallet volume is the point of this script. Absent volume = fresh box
# that has not run the stack yet, nothing to protect, a quiet no-op keeps
# the timer green during first bring-up. Present but incomplete = something
# is wrong, fail loudly rather than archive a wallet with missing pieces.
if ! zallet_dir="$(docker volume inspect -f '{{.Mountpoint}}' "$BACKUP_ZALLET_VOLUME" 2>/dev/null)"; then
  log "volume $BACKUP_ZALLET_VOLUME does not exist yet, nothing to back up"
  exit 0
fi
[ -f "$zallet_dir/wallet.db" ] \
  || die "$BACKUP_ZALLET_VOLUME exists but has no wallet.db, refusing a partial wallet backup"
[ -f "$zallet_dir/encryption-identity.txt" ] \
  || die "$BACKUP_ZALLET_VOLUME has no encryption-identity.txt, refusing a partial wallet backup"

work="$(mktemp -d "$BACKUP_DIR/work/backup.XXXXXX")"
trap 'rm -rf "$work"' EXIT
stage="$work/faucet-backup"
mkdir -p "$stage"

# Consistent point-in-time copy of a live sqlite db (handles WAL, waits out
# writers instead of tearing).
sqlite_backup() {
  python3 - "$1" "$2" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
s.execute("PRAGMA busy_timeout=30000")
d = sqlite3.connect(dst)
with d:
    s.backup(d)
d.close(); s.close()
PY
}

log "backing up wallet from $BACKUP_ZALLET_VOLUME"
cp "$zallet_dir/encryption-identity.txt" "$stage/encryption-identity.txt"
sqlite_backup "$zallet_dir/wallet.db" "$stage/wallet.db"

# The ledger is second-tier: losing it costs cooldown history, not funds.
# Fresh boxes may not have the overlay up yet, so skip is fine, but say so.
if faucet_dir="$(docker volume inspect -f '{{.Mountpoint}}' "$BACKUP_FAUCET_VOLUME" 2>/dev/null)" \
   && [ -f "$faucet_dir/faucet.db" ]; then
  log "backing up rate-limit ledger from $BACKUP_FAUCET_VOLUME"
  sqlite_backup "$faucet_dir/faucet.db" "$stage/faucet.db"
else
  log "no ledger at $BACKUP_FAUCET_VOLUME/faucet.db yet, wallet-only backup"
fi

# A manifest inside the archive: what this is, from where, and content
# hashes so a restore can prove the decrypted payload is intact. Built
# outside the stage dir first, or sha256sum would hash the half-written
# manifest itself and every restore would flunk verification.
{
  echo "created: $(date -u +%FT%TZ)"
  echo "host: $(hostname)"
  echo "network: $BACKUP_NETWORK"
  (cd "$stage" && sha256sum ./*)
} > "$work/MANIFEST"
mv "$work/MANIFEST" "$stage/MANIFEST"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/archives/faucet-backup-$BACKUP_NETWORK-$stamp.tar.gz.gpg"

# Passphrase on fd 3, never on the command line (visible in ps) and never
# on stdin (the tar stream is there).
tar -C "$work" -czf - faucet-backup \
  | gpg --batch --symmetric --cipher-algo AES256 --passphrase-fd 3 \
        --output "$archive.part" 3<<<"$BACKUP_PASSPHRASE"
mv "$archive.part" "$archive"
chmod 600 "$archive"
sha256sum "$archive" | awk '{print $1}' > "${archive%.tar.gz.gpg}.sha256"

# Rotate: newest BACKUP_KEEP stay, older archives and their checksums go.
find "$BACKUP_DIR/archives" -maxdepth 1 -name "faucet-backup-$BACKUP_NETWORK-*.tar.gz.gpg" -printf '%T@ %p\n' \
  | sort -rn | cut -d' ' -f2- | tail -n +"$((BACKUP_KEEP + 1))" \
  | while read -r old; do
      log "rotating out $(basename "$old")"
      rm -f "$old" "${old%.tar.gz.gpg}.sha256"
    done

log "done: $(basename "$archive"), $(du -h "$archive" | cut -f1)"

if [ -n "$BACKUP_UPLOAD_CMD" ]; then
  log "running upload hook"
  $BACKUP_UPLOAD_CMD "$archive" || log "upload hook failed (backup is still good locally)"
fi
