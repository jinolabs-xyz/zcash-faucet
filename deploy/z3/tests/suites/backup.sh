# shellcheck shell=bash
# backup.sh and restore-backup.sh: real sqlite dbs in fake volumes, real gpg.
# Sourced by run-tests.sh, which provides lib.sh and the BACKUP/RESTORE paths.

mkdb()   { python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table t(v)'); c.executemany('insert into t values(?)',[(x,) for x in sys.argv[2:]]); c.commit()" "$@"; }
dumpdb() { python3 -c "import sqlite3,sys; print(*[r[0] for r in sqlite3.connect(sys.argv[1]).execute('select v from t order by v')])" "$1"; }
# A database as a KILLED process leaves it: rows committed to the -wal, never
# checkpointed, sidecars still on disk. os._exit skips SQLite's close, which is
# the whole point — a clean exit checkpoints and truncates the -wal to 0 bytes,
# and a "crashed" db built that way has an empty -wal that proves nothing. I
# wrote that version of this helper first and it passed identically with and
# without the fix (#216).
mkdb_crashed() {
  python3 -c "
import sqlite3, sys, os
c = sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute('PRAGMA wal_autocheckpoint=0')
c.execute('create table t(v)')
c.commit()
c.executemany('insert into t values(?)', [(x,) for x in sys.argv[2:]])
c.commit()
os._exit(0)
" "$@"
}
seed_wallet() {
  mkdir -p "$STUB_VOLROOT/z3-testnet-zallet" "$STUB_VOLROOT/zcash-faucet_faucet_data"
  echo "AGE-SECRET-KEY-STUB" > "$STUB_VOLROOT/z3-testnet-zallet/identity.txt"
  mkdb "$STUB_VOLROOT/z3-testnet-zallet/wallet.db" note1 note2
  mkdb "$STUB_VOLROOT/zcash-faucet_faucet_data/faucet.db" claim1
}
backup_env() {
  unset BACKUP_KEEP BACKUP_UPLOAD_CMD 2>/dev/null
  export BACKUP_DIR="$T/backups" BACKUP_PASSPHRASE="test-passphrase"
}

echo "== backup: happy path produces a decryptable, verified archive"
fresh_env; backup_env; seed_wallet
bash "$BACKUP" > "$T/b1.log" 2>&1
check "backup exits 0" "[ $? -eq 0 ]"
archive="$(find "$BACKUP_DIR/archives" -name '*.tar.gz.gpg' | head -1)"
check "archive exists" "[ -n '$archive' ]"
check "archive is mode 600" "[ \"\$(stat -c %a '$archive')\" = '600' ]"
check "sha256 sidecar matches" "[ \"\$(cat \"\${archive%.tar.gz.gpg}.sha256\")\" = \"\$(sha256sum '$archive' | cut -d' ' -f1)\" ]"
mkdir -p "$T/out"
gpg --batch --quiet -d --passphrase-fd 3 3<<<"test-passphrase" "$archive" | tar -xzf - -C "$T/out"
check "decrypts with the passphrase" "[ $? -eq 0 ]"
check "identity in archive" "grep -q AGE-SECRET-KEY-STUB '$T/out/faucet-backup/encryption-identity.txt'"
check "wallet content survived" "[ \"\$(dumpdb '$T/out/faucet-backup/wallet.db')\" = 'note1 note2' ]"
check "ledger content survived" "[ \"\$(dumpdb '$T/out/faucet-backup/faucet.db')\" = 'claim1' ]"
check "manifest verifies" "(cd '$T/out/faucet-backup' && grep -E '^[0-9a-f]{64} ' MANIFEST | sha256sum -c --quiet -)"

echo "== backup: refusals and skips"
fresh_env; backup_env; seed_wallet
BACKUP_PASSPHRASE='' bash "$BACKUP" > "$T/nopass.log" 2>&1
check "no passphrase -> refuses" "[ $? -ne 0 ] && grep -q 'refusing an unencrypted backup' '$T/nopass.log'"
fresh_env; backup_env
bash "$BACKUP" > "$T/fresh.log" 2>&1
check "no zallet volume -> quiet exit 0" "[ $? -eq 0 ] && grep -q 'nothing to back up' '$T/fresh.log'"
fresh_env; backup_env
mkdir -p "$STUB_VOLROOT/z3-testnet-zallet"
bash "$BACKUP" > "$T/nowallet.log" 2>&1
check "volume without wallet.db -> loud failure" "[ $? -ne 0 ] && grep -q 'no wallet.db' '$T/nowallet.log'"
fresh_env; backup_env
mkdir -p "$STUB_VOLROOT/z3-testnet-zallet"
echo id > "$STUB_VOLROOT/z3-testnet-zallet/identity.txt"
mkdb "$STUB_VOLROOT/z3-testnet-zallet/wallet.db" n1
bash "$BACKUP" > "$T/noledger.log" 2>&1
check "missing ledger -> wallet-only backup, said so" "[ $? -eq 0 ] && grep -q 'wallet-only' '$T/noledger.log'"

echo "== backup: rotation and upload hook"
fresh_env; backup_env; seed_wallet
export BACKUP_KEEP=2
hook="$T/hook.log"
# The $1 must land literally in the hook script, expansion happens when the
# hook runs, not here.
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\necho "$1" >> %q\n' "$hook" > "$T/hook.sh" && chmod +x "$T/hook.sh"
export BACKUP_UPLOAD_CMD="$T/hook.sh"
for i in 1 2 3; do bash "$BACKUP" > "$T/rot-$i.log" 2>&1 || bad "rotation run $i failed"; sleep 1.1; done
n="$(find "$BACKUP_DIR/archives" -name '*.tar.gz.gpg' | wc -l | tr -d ' ')"
check "rotation keeps 2 (got $n)" "[ '$n' = '2' ]"
check "sidecars rotated with archives" "[ \"\$(find '$BACKUP_DIR/archives' -name '*.sha256' | wc -l | tr -d ' ')\" = '2' ]"
check "upload hook called every run" "[ \"\$(wc -l < '$hook' | tr -d ' ')\" = '3' ]"

echo "== restore: roundtrip into empty volumes"
fresh_env; backup_env; seed_wallet
bash "$BACKUP" > /dev/null 2>&1
rm -rf "$STUB_VOLROOT/z3-testnet-zallet" "$STUB_VOLROOT/zcash-faucet_faucet_data"
bash "$RESTORE" > "$T/r1.log" 2>&1
check "restore exits 0" "[ $? -eq 0 ]"
check "identity restored" "grep -q AGE-SECRET-KEY-STUB '$STUB_VOLROOT/z3-testnet-zallet/identity.txt'"
check "wallet restored intact" "[ \"\$(dumpdb '$STUB_VOLROOT/z3-testnet-zallet/wallet.db')\" = 'note1 note2' ]"
check "ledger restored intact" "[ \"\$(dumpdb '$STUB_VOLROOT/zcash-faucet_faucet_data/faucet.db')\" = 'claim1' ]"

echo "== backup captures state that lives ONLY in the -wal (#216)"
# On the live box faucet.db is 4KB and faucet.db-wal is 358KB: essentially the
# whole ledger is uncheckpointed. A backup that copied the .db file would archive
# almost nothing, and would report success doing it.
#
# backup.sh does NOT copy the file — sqlite_backup() reads through a connection
# with sqlite's online backup API, which sees the logical database including
# uncheckpointed WAL frames. That property was only ever asserted in a comment,
# so this pins it. Measured directly: a plain `cp` of the same db yields
# "no such table", the API yields every row.
fresh_env; backup_env
mkdir -p "$STUB_VOLROOT/z3-testnet-zallet" "$STUB_VOLROOT/zcash-faucet_faucet_data"
echo "AGE-SECRET-KEY-STUB" > "$STUB_VOLROOT/z3-testnet-zallet/identity.txt"
mkdb "$STUB_VOLROOT/z3-testnet-zallet/wallet.db" note1 note2
mkdb_crashed "$STUB_VOLROOT/zcash-faucet_faucet_data/faucet.db" only-in-wal
check "the ledger's rows really are only in the -wal" \
  "[ -s '$STUB_VOLROOT/zcash-faucet_faucet_data/faucet.db-wal' ]"
bash "$BACKUP" > "$T/bwal.log" 2>&1
check "backup of a WAL-only ledger exits 0" "[ $? -eq 0 ]"
# fresh_env gave this case its own $T, so the archive has to be unpacked here
# rather than reusing the happy path's $T/out.
walarch="$(find "$BACKUP_DIR/archives" -name '*.tar.gz.gpg' | head -1)"
check "WAL-only backup produced an archive" "[ -n '$walarch' ]"
mkdir -p "$T/walout"
gpg --batch --quiet -d --passphrase-fd 3 3<<<"test-passphrase" "$walarch" | tar -xzf - -C "$T/walout"
check "and the archived ledger CONTAINS the uncheckpointed row" \
  "[ \"\$(dumpdb '$T/walout/faucet-backup/faucet.db')\" = 'only-in-wal' ]"

echo "== the sidecar removal happens BEFORE the install, not after (#216)"
# A source-order assertion, which is unusual, and it is here because the two orders
# are indistinguishable from the outside on a completed run — every behavioural test
# below passes either way. The difference only shows in the crash window: with the
# rm AFTER the install, a crash between them leaves the new db wearing the old db's
# WAL and the next reader silently gets PRE-CRASH data. I shipped that order first
# with a comment arguing it was the safe one, and the comment was wrong. Nothing
# except this check would notice it being flipped back.
rm_line="$(grep -n 'rm -f "\$2-wal"' "$REPO/deploy/z3/restore-backup.sh" | head -1 | cut -d: -f1)"
inst_line="$(grep -n 'install -m 600 "\$1" "\$2"' "$REPO/deploy/z3/restore-backup.sh" | head -1 | cut -d: -f1)"
check "both lines were found (an empty match would compare as equal and pass)" \
  "[ -n '$rm_line' ] && [ -n '$inst_line' ]"
check "sidecars are removed before the database is written" "[ '$rm_line' -lt '$inst_line' ]"

echo "== restore over a CRASHED database returns the backup, not the pre-crash data (#216)"
# The defect: a killed process leaves a populated -wal, restore replaced only the
# .db, and the next reader replayed that stale -wal over the freshly installed
# backup. Pre-crash data served, backup contents gone, exit 0, log says
# "restored". This has to be checked by READING THE ROWS, because the script's
# output is byte-identical whether it worked or silently discarded the restore.
#
# Both databases, because wallet.db is the funds database and has the same shape.
fresh_env; backup_env; seed_wallet
bash "$BACKUP" > /dev/null 2>&1
rm -rf "$STUB_VOLROOT/z3-testnet-zallet" "$STUB_VOLROOT/zcash-faucet_faucet_data"
mkdir -p "$STUB_VOLROOT/z3-testnet-zallet" "$STUB_VOLROOT/zcash-faucet_faucet_data"
echo "AGE-SECRET-KEY-STALE" > "$STUB_VOLROOT/z3-testnet-zallet/identity.txt"
mkdb_crashed "$STUB_VOLROOT/z3-testnet-zallet/wallet.db" precrash-note
mkdb_crashed "$STUB_VOLROOT/zcash-faucet_faucet_data/faucet.db" precrash-claim
# Guard the guard: if the helper stopped leaving a -wal, every assertion below
# would pass while testing nothing at all.
check "the crashed-db helper really left a populated -wal" \
  "[ -s '$STUB_VOLROOT/z3-testnet-zallet/wallet.db-wal' ]"
FORCE=1 bash "$RESTORE" > "$T/rcrash.log" 2>&1
check "FORCE restore over a crashed db exits 0" "[ $? -eq 0 ]"
check "wallet.db holds the BACKUP row, not the pre-crash one" \
  "[ \"\$(dumpdb '$STUB_VOLROOT/z3-testnet-zallet/wallet.db')\" = 'note1 note2' ]"
check "faucet.db holds the BACKUP row, not the pre-crash one" \
  "[ \"\$(dumpdb '$STUB_VOLROOT/zcash-faucet_faucet_data/faucet.db')\" = 'claim1' ]"
check "and the stale wallet sidecars are gone" \
  "[ ! -f '$STUB_VOLROOT/z3-testnet-zallet/wallet.db-wal' ] && [ ! -f '$STUB_VOLROOT/z3-testnet-zallet/wallet.db-shm' ]"

echo "== a -wal with no .db beside it is a crashed database, not an absent one (#216)"
# The second way through, and it needs no FORCE: delete the .db, leave the -wal,
# and the old refusal saw nothing there and allowed the restore.
fresh_env; backup_env; seed_wallet
bash "$BACKUP" > /dev/null 2>&1
mkdb_crashed "$T/scratch.db" x
rm -rf "$STUB_VOLROOT/z3-testnet-zallet" "$STUB_VOLROOT/zcash-faucet_faucet_data"
mkdir -p "$STUB_VOLROOT/z3-testnet-zallet"
cp "$T/scratch.db-wal" "$STUB_VOLROOT/z3-testnet-zallet/wallet.db-wal"
bash "$RESTORE" > "$T/rorphan.log" 2>&1
check "an orphaned -wal is refused without FORCE" "[ $? -ne 0 ]"
check "and it says a crashed database rather than something vague" \
  "grep -q 'crashed database, not an absent one' '$T/rorphan.log'"
check "and nothing was written" "[ ! -f '$STUB_VOLROOT/z3-testnet-zallet/wallet.db' ]"

echo "== restore: refusals"
fresh_env; backup_env; seed_wallet
bash "$BACKUP" > /dev/null 2>&1
echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
bash "$RESTORE" > "$T/rrun.log" 2>&1
check "refuses while zallet runs" "[ $? -ne 0 ] && grep -q 'stop the stack' '$T/rrun.log'"
rm -f "$STUB_CONTAINERS/z3-testnet-zallet-1"
bash "$RESTORE" > "$T/rclob.log" 2>&1
check "refuses to clobber existing wallet.db" "[ $? -ne 0 ] && grep -q 'refusing to overwrite' '$T/rclob.log'"
FORCE=1 bash "$RESTORE" > "$T/rforce.log" 2>&1
check "FORCE=1 overrides" "[ $? -eq 0 ]"
archive="$(find "$BACKUP_DIR/archives" -name '*.tar.gz.gpg' | head -1)"
printf '0%.0s' {1..64} > "${archive%.tar.gz.gpg}.sha256"
rm -rf "$STUB_VOLROOT/z3-testnet-zallet"
bash "$RESTORE" > "$T/rtamper.log" 2>&1
check "tampered sidecar -> refuses" "[ $? -ne 0 ] && grep -q 'does not match its .sha256' '$T/rtamper.log'"
# Clear the tampered sidecar so this run gets PAST the sidecar gate and
# actually exercises gpg, and assert on gpg's own failure, not bare nonzero.
rm -f "${archive%.tar.gz.gpg}.sha256"
BACKUP_PASSPHRASE=wrong bash "$RESTORE" "$archive" > "$T/rwrong.log" 2>&1
check "wrong passphrase -> gpg decryption fails" "[ $? -ne 0 ] && grep -qi 'decryption failed' '$T/rwrong.log'"

echo "== restore: clobber refusal writes nothing at all"
fresh_env; backup_env; seed_wallet
bash "$BACKUP" > /dev/null 2>&1
# Destination that would pass the identity write and fail on wallet.db: the
# old per-file check restored the identity first, pairing new keys with the
# old wallet. The refusal must fire before any write.
rm -rf "$STUB_VOLROOT/z3-testnet-zallet"
mkdir -p "$STUB_VOLROOT/z3-testnet-zallet"
mkdb "$STUB_VOLROOT/z3-testnet-zallet/wallet.db" oldnote
bash "$RESTORE" > "$T/rpartial.log" 2>&1
check "refuses on the later-checked file" "[ $? -ne 0 ] && grep -q 'refusing to overwrite' '$T/rpartial.log'"
check "identity was NOT written" "[ ! -f '$STUB_VOLROOT/z3-testnet-zallet/identity.txt' ]"
check "old wallet untouched" "[ \"\$(dumpdb '$STUB_VOLROOT/z3-testnet-zallet/wallet.db')\" = 'oldnote' ]"