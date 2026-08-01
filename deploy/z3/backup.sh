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
# The identity filename INSIDE the zallet volume. z3's shipped zallet.toml
# sets keystore.encryption_identity to /var/lib/zallet/identity.txt, which
# overrides zallet's own encryption-identity.txt default, so identity.txt is
# what actually exists on a z3 box. Match your config if you changed it.
BACKUP_IDENTITY_FILE="${BACKUP_IDENTITY_FILE:-identity.txt}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"              # archives kept after a new one lands
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-}"    # required, see header
BACKUP_UPLOAD_CMD="${BACKUP_UPLOAD_CMD:-}"    # optional: run <cmd> <archive> after backup

log() { echo "$(date -u +%FT%TZ) faucet-backup: $*"; }
die() { log "ERROR: $*"; exit 1; }

# KEEP=0 makes the rotation below `tail -n +1`, which deletes EVERY archive including the
# one this run just created: a backup job whose successful outcome is no backup. Checked
# HERE rather than beside the assignment because die() has to exist first; my first
# version put it with the config and produced `die: command not found`, exit 127, which
# is a worse failure than the one it was guarding against.
#
# Refused rather than clamped: someone who wrote 0 meant something, and guessing which is
# worse than asking.
case "$BACKUP_KEEP" in
  ''|*[!0-9]*) die "BACKUP_KEEP must be a whole number, got '$BACKUP_KEEP'" ;;
esac
[ "$BACKUP_KEEP" -ge 1 ] \
  || die "BACKUP_KEEP must be at least 1, got $BACKUP_KEEP: rotation would delete the archive this run just made"

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
[ -f "$zallet_dir/$BACKUP_IDENTITY_FILE" ] \
  || die "$BACKUP_ZALLET_VOLUME has no $BACKUP_IDENTITY_FILE, refusing a partial wallet backup (BACKUP_IDENTITY_FILE if yours is named differently)"

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
# The member name inside the archive is constant regardless of what the box
# config calls the file, so archives restore across config changes.
cp "$zallet_dir/$BACKUP_IDENTITY_FILE" "$stage/encryption-identity.txt"
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

# POST-CONDITION: PROVE THE ARCHIVE OPENS.
#
# Until now this script wrote a file and reported done. Whether that file could ever be
# decrypted was untested on every run, and the whole point of a backup is the day you
# find out. The CTO's own summary of our position was "backups are encrypted and run on a
# timer, AND we have never restored one".
#
# So the run now decrypts what it just wrote and checks the payload against the MANIFEST
# it built. Streamed, never extracted to disk: this box has been at 100% disk once
# already, and a verification step that needs another copy of the archive is a
# verification step that gets removed the first time it fills the volume.
#
# This does NOT make a restore tested end to end; restore-backup.sh and its refusals are
# still their own path. It makes "the bytes we wrote are the bytes we meant, and they
# decrypt with the passphrase we used" true on every run instead of assumed.
# VERIFY_FAIL is set to a short token at whichever check fails, so the note beside a kept
# archive can name it. App's point, and it is the right one: the note is meant to be the
# thing that survives, and "see the log" is the one fact it cannot carry, because logs
# rotate and get read on a different day than the file is found.
VERIFY_FAIL=""
verify_archive() {
  local a="$1" manifest name want got
  VERIFY_FAIL=""
  manifest="$(gpg --batch --quiet --decrypt --passphrase-fd 3 "$a" 3<<<"$BACKUP_PASSPHRASE" \
                | tar -xzO faucet-backup/MANIFEST 2>/dev/null)" \
    || { VERIFY_FAIL="did-not-decrypt"; log "ERROR: the archive did not decrypt with the passphrase this run used"; return 1; }
  [ -n "$manifest" ] || { VERIFY_FAIL="no-manifest"; log "ERROR: no MANIFEST inside the archive"; return 1; }

  # sha256sum lines only: the manifest also carries created/host/network headers.
  #
  # Fed by here-doc, NOT by a pipe. `... | while read` runs the loop in a SUBSHELL, so a
  # `return 1` inside it would exit the subshell and leave this function reporting
  # success: a verification that cannot fail, which is the exact thing this whole change
  # exists to remove. I wrote it as a pipe first and caught it before running it, having
  # already been bitten by the same subshell rule swallowing probe_state's globals.
  local lines
  lines="$(printf '%s\n' "$manifest" | grep -E '^[0-9a-f]{64}  \./' || true)"
  [ -n "$lines" ] || { VERIFY_FAIL="manifest-has-no-hashes"; log "ERROR: the MANIFEST carries no file hashes, so there is nothing to verify against"; return 1; }
  local checked=0
  while read -r want name; do
    [ -n "$want" ] || continue
    name="${name#./}"
    got="$(gpg --batch --quiet --decrypt --passphrase-fd 3 "$a" 3<<<"$BACKUP_PASSPHRASE" \
             | tar -xzO "faucet-backup/$name" 2>/dev/null | sha256sum | cut -d' ' -f1)"
    if [ "$got" != "$want" ]; then
      log "ERROR: $name inside the archive does not match the manifest"
      log "  manifest: $want"
      log "  archive:  ${got:-<could not read>}"
      VERIFY_FAIL="content-mismatch:$name"
      return 1
    fi
    checked=$((checked + 1))
    log "verified $name"
  done <<EOF
$lines
EOF
  # A loop that ran zero times must not read as success. Same shape as the empty-source
  # refusal in install-ops: nothing compared is not everything matching.
  [ "$checked" -gt 0 ] || { VERIFY_FAIL="verified-nothing"; log "ERROR: verified nothing, so the archive is unproven"; return 1; }
  return 0
}

verified_note=""
if verify_archive "$archive"; then
  # The word "verified" in the done line is set HERE, by the check succeeding, rather than
  # written into the message. Sabotaging the call turned two assertions red and left the
  # done line still claiming verified, because I had hardcoded it: a report derived from
  # the text I typed instead of from the thing it describes, which is the same fault as
  # the watchdog announcing 812 recoveries it never observed.
  verified_note=", verified"
else
  # Kept as evidence, renamed so rotation and any restore cannot mistake it for a good
  # one, and AT MOST ONE.
  #
  # App found the loop in my first version: rotation globs *.tar.gz.gpg, so a .unverified
  # is never swept, and a disk-full event would permanently consume disk with the evidence
  # OF the disk-full event. Smaller stakes here than for a multi-GB snapshot, but the same
  # unbounded growth, and the two scripts must behave the same way rather than one being
  # the surprise.
  rm -f "$BACKUP_DIR/archives/"*.tar.gz.gpg.unverified "$BACKUP_DIR/archives/"*.unverified.txt 2>/dev/null || true
  mv "$archive" "$archive.unverified" 2>/dev/null || true
  rm -f "${archive%.tar.gz.gpg}.sha256"
  {
    echo "failed: $(date -u +%FT%TZ)"
    echo "network: $BACKUP_NETWORK"
    echo "bytes: $(wc -c < "$archive.unverified" 2>/dev/null || echo unknown)"
    echo "failed check: ${VERIFY_FAIL:-unknown}"
  } > "$archive.unverified.txt" 2>/dev/null || true
  die "the archive this run produced did not verify, kept as $(basename "$archive").unverified"
fi

# Rotate: newest BACKUP_KEEP stay, older archives and their checksums go.
find "$BACKUP_DIR/archives" -maxdepth 1 -name "faucet-backup-$BACKUP_NETWORK-*.tar.gz.gpg" -printf '%T@ %p\n' \
  | sort -rn | cut -d' ' -f2- | tail -n +"$((BACKUP_KEEP + 1))" \
  | while read -r old; do
      log "rotating out $(basename "$old")"
      rm -f "$old" "${old%.tar.gz.gpg}.sha256"
    done

log "done: $(basename "$archive"), $(du -h "$archive" | cut -f1)${verified_note}"

if [ -n "$BACKUP_UPLOAD_CMD" ]; then
  log "running upload hook"
  $BACKUP_UPLOAD_CMD "$archive" || log "upload hook failed (backup is still good locally)"
fi
