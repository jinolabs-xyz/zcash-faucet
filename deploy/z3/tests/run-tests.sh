#!/usr/bin/env bash
# Single entrypoint for the deploy/z3 shell-tooling tests: zsnap export and
# import, then the wallet backup and restore pair. Docker (and for zsnap,
# zebrad/systemctl/curl) come from tests/stubs/; sqlite, tar, gpg and the
# hash checks in the backup tests run for real.
#
# Needs Linux (flock, GNU find) plus zstd, gnupg, python3. From a Mac or a
# clean room:
#   docker run --rm -v "$(git rev-parse --show-toplevel)":/repo:ro ubuntu:24.04 \
#     bash -c 'apt-get update -qq && apt-get install -y -qq zstd curl gnupg python3 \
#              && bash /repo/deploy/z3/tests/run-tests.sh'
# Scratch state goes under TMPDIR, never into the repo.
set -uo pipefail

SCRATCH="${TEST_SCRATCH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO="${TEST_REPO:-$(cd "$SCRATCH/../../.." && pwd)}"
EXPORT="$REPO/deploy/z3/zsnap-export.sh"
IMPORT="$REPO/deploy/z3/zsnap-import.sh"
BACKUP="$REPO/deploy/z3/backup.sh"
RESTORE="$REPO/deploy/z3/restore-backup.sh"

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ok: $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL: $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }
# Asserts the first log line matching $2 comes before the first matching $3.
check_order() {
  local a b
  a="$(grep -n "$2" "$STUB_LOG" | head -1 | cut -d: -f1)"
  b="$(grep -n "$3" "$STUB_LOG" | head -1 | cut -d: -f1)"
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then ok "$1"; else bad "$1 (got '$2'@${a:-none} vs '$3'@${b:-none})"; fi
}

fresh_env() {
  T="$(mktemp -d "${TMPDIR:-/tmp}/zsnap-test.XXXXXX")"
  export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
  export STUB_VOLROOT="$T/volumes"; mkdir -p "$STUB_VOLROOT"
  export STUB_CONTAINERS="$T/containers"; mkdir -p "$STUB_CONTAINERS"
  export STUB_SYSTEMD="$T/systemd"; mkdir -p "$STUB_SYSTEMD"
  export PATH="$SCRATCH/stubs:$PATH"
  export ZSNAP_DIR="$T/zsnap"
  export ZSNAP_ZEBRAD="$SCRATCH/stubs/zebrad-stub"
  export ZSNAP_RETRY_WAIT=1
  export STUB_CACHE_DIR="$STUB_VOLROOT/z3-testnet-chain"
  unset ZSNAP_SOURCE ZSNAP_EXPECT_HASH ZSNAP_ALLOW_UNVERIFIED ZSNAP_MODE \
        STUB_IMPORT_FAIL STUB_EXPORT_FAIL STUB_EXPORT_FAIL_ONCE STUB_READY STUB_WD_STUCK 2>/dev/null
  export ZSNAP_SOURCE_FILE="$T/restore-url"   # keep /etc out of the tests
}
with_chain() { mkdir -p "$STUB_CACHE_DIR"; head -c 100000 /dev/urandom > "$STUB_CACHE_DIR/some.sst"; }

echo "== export hot (default): happy path, then rotation over 3 runs (keep 2)"
fresh_env; with_chain
for i in 1 2 3; do
  sed "s/3652108/365210$i/" "$SCRATCH/stubs/zebrad-stub" > "$T/zebrad-$i" && chmod +x "$T/zebrad-$i"
  ZSNAP_ZEBRAD="$T/zebrad-$i" bash "$EXPORT" > "$T/export-$i.log" 2>&1 || bad "export run $i exited $? (see $T/export-$i.log)"
done
n_archives="$(find "$ZSNAP_DIR/snapshots" -name 'zsnap-testnet-*.tar.zst' | wc -l | tr -d ' ')"
check "rotation keeps 2 archives (got $n_archives)" "[ '$n_archives' = '2' ]"
check "oldest archive rotated out" "! find '$ZSNAP_DIR/snapshots' -name '*3652101*' | grep -q ."
check "latest symlink points at newest" "[ \"\$(readlink '$ZSNAP_DIR/snapshots/latest.tar.zst')\" = 'zsnap-testnet-3652103-deadbeefcafe.tar.zst' ]"
check "sidecar has full manifest hash" "grep -q '^deadbeefcafe.*0123$' '$ZSNAP_DIR/snapshots/latest.manifest-hash'"
check "archive unpacks to snapshot/MANIFEST.json" "zstd -dc \"$ZSNAP_DIR/snapshots/\$(readlink '$ZSNAP_DIR/snapshots/latest.tar.zst')\" | tar -tf - | grep -q 'snapshot/MANIFEST.json'"
check "workdir cleaned up" "[ -z \"\$(ls -A '$ZSNAP_DIR/work')\" ]"
check "hot mode never stops a container" "! grep -q 'docker stop' '$STUB_LOG'"

echo "== export hot: transient failure retried, then succeeds"
fresh_env; with_chain
STUB_EXPORT_FAIL_ONCE="$T/failed-once" bash "$EXPORT" > "$T/retry.log" 2>&1
check "exit 0 after retry" "[ $? -eq 0 ]"
check "two export attempts in log" "[ \"\$(grep -c 'zebrad export-snapshot' '$STUB_LOG')\" = '2' ]"
check "retry was announced" "grep -q 'retrying in' '$T/retry.log'"

echo "== export hot: persistent failure gives up after ZSNAP_RETRIES"
fresh_env; with_chain
STUB_EXPORT_FAIL=1 ZSNAP_RETRIES=2 bash "$EXPORT" > "$T/exhaust.log" 2>&1
check "exit nonzero" "[ $? -ne 0 ]"
check "exactly 2 attempts" "[ \"\$(grep -c 'zebrad export-snapshot' '$STUB_LOG')\" = '2' ]"
check "gives up honestly" "grep -q 'giving up' '$T/exhaust.log'"

echo "== export cold: watchdog paused first, zebra stopped, both restored"
fresh_env; with_chain
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo active > "$STUB_SYSTEMD/faucet-watchdog"
ZSNAP_MODE=cold bash "$EXPORT" > "$T/cold.log" 2>&1
check "cold export exits 0" "[ $? -eq 0 ]"
check_order "watchdog stopped before zebra" "systemctl stop faucet-watchdog" "docker stop"
check_order "zebra stopped before export" "docker stop" "zebrad export-snapshot"
check_order "zebra restarted after export" "zebrad export-snapshot" "docker start z3-testnet-zebra-1"
check_order "watchdog restarted after zebra" "docker start" "systemctl start faucet-watchdog"
check "zebra running at end" "[ \"\$(cat '$STUB_CONTAINERS/z3-testnet-zebra-1')\" = 'running' ]"
check "watchdog active at end" "[ \"\$(cat '$STUB_SYSTEMD/faucet-watchdog')\" = 'active' ]"
check "window marker removed" "[ ! -f '$ZSNAP_DIR/.window' ]"

echo "== export cold: failed export still restarts zebra and watchdog (trap)"
fresh_env; with_chain
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo active > "$STUB_SYSTEMD/faucet-watchdog"
STUB_EXPORT_FAIL=1 ZSNAP_MODE=cold ZSNAP_RETRIES=1 bash "$EXPORT" > "$T/coldfail.log" 2>&1
check "exit nonzero" "[ $? -ne 0 ]"
check "zebra running again despite failure" "[ \"\$(cat '$STUB_CONTAINERS/z3-testnet-zebra-1')\" = 'running' ]"
check "watchdog active again despite failure" "[ \"\$(cat '$STUB_SYSTEMD/faucet-watchdog')\" = 'active' ]"
check "window marker removed" "[ ! -f '$ZSNAP_DIR/.window' ]"

echo "== export cold: refuses the window if the watchdog will not stop"
fresh_env; with_chain
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo active > "$STUB_SYSTEMD/faucet-watchdog"
STUB_WD_STUCK=1 ZSNAP_MODE=cold bash "$EXPORT" > "$T/stuck.log" 2>&1
check "exit nonzero" "[ $? -ne 0 ]"
check "refusal names the guard" "grep -q 'still active after stop' '$T/stuck.log'"
check "zebra was never stopped" "! grep -q 'docker stop' '$STUB_LOG'"

echo "== export: recover puts an interrupted window back"
fresh_env
mkdir -p "$ZSNAP_DIR"
echo exited > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo inactive > "$STUB_SYSTEMD/faucet-watchdog"
echo "z3-testnet-zebra-1 1" > "$ZSNAP_DIR/.window"
bash "$EXPORT" recover > "$T/recover.log" 2>&1
check "recover exits 0" "[ $? -eq 0 ]"
check "zebra restarted" "[ \"\$(cat '$STUB_CONTAINERS/z3-testnet-zebra-1')\" = 'running' ]"
check "watchdog restarted" "[ \"\$(cat '$STUB_SYSTEMD/faucet-watchdog')\" = 'active' ]"
check "marker consumed" "[ ! -f '$ZSNAP_DIR/.window' ]"
bash "$EXPORT" recover > "$T/recover2.log" 2>&1
check "recover without marker is a quiet no-op" "[ $? -eq 0 ]"

echo "== export: ready gate blocks, ZSNAP_FORCE=1 overrides"
fresh_env; with_chain
STUB_READY=0 bash "$EXPORT" > "$T/gate.log" 2>&1
check "not-ready export refuses (exit != 0)" "[ $? -ne 0 ]"
check "refusal names the gate" "grep -q 'not ready' '$T/gate.log'"
STUB_READY=0 ZSNAP_FORCE=1 bash "$EXPORT" > "$T/force.log" 2>&1
check "ZSNAP_FORCE=1 exports anyway" "[ $? -eq 0 ]"

echo "== export: missing volume fails clearly"
fresh_env
bash "$EXPORT" > "$T/novol.log" 2>&1
check "no volume -> nonzero exit" "[ $? -ne 0 ]"
check "error names the volume" "grep -q 'z3-testnet-chain not found' '$T/novol.log'"

echo "== export: concurrent run skips via flock"
fresh_env; with_chain
mkdir -p "$ZSNAP_DIR"
( exec 9>"$ZSNAP_DIR/.export.lock"; flock 9; sleep 3 ) &
holder=$!
sleep 0.3
bash "$EXPORT" > "$T/lock.log" 2>&1
check "locked export exits nonzero" "[ $? -ne 0 ]"
check "locked export says why" "grep -q 'already running' '$T/lock.log'"
wait "$holder"

echo "== import: no source configured is a quiet no-op"
fresh_env
bash "$IMPORT" > "$T/nosrc.log" 2>&1
check "exit 0" "[ $? -eq 0 ]"
check "says nothing to restore" "grep -q 'nothing to restore' '$T/nosrc.log'"

echo "== import: restores from local archive with sidecar hash"
fresh_env
mkdir -p "$T/snapdir/chunks"; echo '{"stub":true}' > "$T/snapdir/MANIFEST.json"; echo data > "$T/snapdir/chunks/c1"
tar -C "$T" -cf - snapdir | zstd -q -o "$T/snap.tar.zst"
echo "deadbeefcafe0123" > "$T/snap.tar.zst.manifest-hash"
bash "$IMPORT" "$T/snap.tar.zst" > "$T/imp.log" 2>&1
check "import exits 0" "[ $? -eq 0 ]"
check "volume was created" "[ -d '$STUB_VOLROOT/z3-testnet-chain' ]"
check "state db landed" "[ -f '$STUB_CACHE_DIR/state/v27/testnet/db.stub' ]"
check "expect-hash from sidecar passed to zebrad" "grep -q -- '--expect-hash deadbeefcafe0123' '$STUB_LOG'"
check "import workdir cleaned" "[ -z \"\$(ls -A '$ZSNAP_DIR/work')\" ]"

echo "== import: second run is a no-op (state exists)"
bash "$IMPORT" "$T/snap.tar.zst" > "$T/imp2.log" 2>&1
check "exit 0" "[ $? -eq 0 ]"
check "says nothing to do" "grep -q 'nothing to do' '$T/imp2.log'"
check "zebrad not invoked again" "[ \"\$(grep -c 'zebrad import-snapshot' '$STUB_LOG')\" = '1' ]"

echo "== import: no hash and no allow-unverified passes neither flag through"
fresh_env
mkdir -p "$T/plain"; echo '{}' > "$T/plain/MANIFEST.json"
bash "$IMPORT" "$T/plain" > "$T/plain.log" 2>&1
check "plain dir import ran" "[ $? -eq 0 ]"
check "no --expect-hash sent" "! grep -q -- '--expect-hash' '$STUB_LOG'"
check "no --allow-unverified sent" "! grep -q -- '--allow-unverified' '$STUB_LOG'"

echo "== import: ZSNAP_ALLOW_UNVERIFIED=1 passes the flag"
fresh_env
mkdir -p "$T/plain"; echo '{}' > "$T/plain/MANIFEST.json"
ZSNAP_ALLOW_UNVERIFIED=1 bash "$IMPORT" "$T/plain" > /dev/null 2>&1
check "--allow-unverified sent" "grep -q -- '--allow-unverified' '$STUB_LOG'"

echo "== import: directory-style URL goes through --url"
fresh_env
bash "$IMPORT" "https://snap.example.org/testnet/latest" > "$T/url.log" 2>&1
check "exit 0" "[ $? -eq 0 ]"
check "--url passed through" "grep -q -- '--url https://snap.example.org/testnet/latest' '$STUB_LOG'"

echo "== import: failure sweeps the leftover tempdir and exits nonzero"
fresh_env
mkdir -p "$T/plain"; echo '{}' > "$T/plain/MANIFEST.json"
STUB_IMPORT_FAIL=1 bash "$IMPORT" "$T/plain" > "$T/fail.log" 2>&1
check "failed import exits nonzero" "[ $? -ne 0 ]"
check "zsnap-import-* tempdir swept" "! ls -d '$STUB_CACHE_DIR'/zsnap-import-* 2>/dev/null | grep -q ."
check "no state dir left behind" "[ ! -d '$STUB_CACHE_DIR/state' ]"

# ---------------------------------------------------------------------------
# backup.sh / restore-backup.sh. Real sqlite dbs in fake volumes, real gpg.

mkdb()   { python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table t(v)'); c.executemany('insert into t values(?)',[(x,) for x in sys.argv[2:]]); c.commit()" "$@"; }
dumpdb() { python3 -c "import sqlite3,sys; print(*[r[0] for r in sqlite3.connect(sys.argv[1]).execute('select v from t order by v')])" "$1"; }
seed_wallet() {
  mkdir -p "$STUB_VOLROOT/z3-testnet-zallet" "$STUB_VOLROOT/zcash-faucet_faucet_data"
  echo "AGE-SECRET-KEY-STUB" > "$STUB_VOLROOT/z3-testnet-zallet/encryption-identity.txt"
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
echo id > "$STUB_VOLROOT/z3-testnet-zallet/encryption-identity.txt"
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
check "identity restored" "grep -q AGE-SECRET-KEY-STUB '$STUB_VOLROOT/z3-testnet-zallet/encryption-identity.txt'"
check "wallet restored intact" "[ \"\$(dumpdb '$STUB_VOLROOT/z3-testnet-zallet/wallet.db')\" = 'note1 note2' ]"
check "ledger restored intact" "[ \"\$(dumpdb '$STUB_VOLROOT/zcash-faucet_faucet_data/faucet.db')\" = 'claim1' ]"

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
BACKUP_PASSPHRASE=wrong bash "$RESTORE" "$archive" > "$T/rwrong.log" 2>&1
check "wrong passphrase -> fails" "[ $? -ne 0 ]"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
