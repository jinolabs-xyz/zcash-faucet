# shellcheck shell=bash
# zsnap-export.sh and zsnap-import.sh. Sourced by run-tests.sh, which
# provides the helpers in lib.sh and the EXPORT/IMPORT paths.

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
echo "== export: preflight answers can-this-binary-open-this-state"
fresh_env; with_chain
mkdir -p "$STUB_CACHE_DIR/state/v28/testnet"
TMPDIR="$T" bash "$EXPORT" preflight > "$T/pf-go.log" 2>&1
check "preflight exits 0 when the binary can open the state" "[ $? -eq 0 ]"
check "says GO with the tip height" "grep -q 'GO: the export binary opened the state, tip height 3652108' '$T/pf-go.log'"
check "reports the on-disk state format" "grep -q 'state formats:.*v28' '$T/pf-go.log'"
check "preflight never exports" "! grep -q 'export-snapshot' '$STUB_LOG'"

# A busy node can fail one read-only open transiently, and that error reads
# like a format mismatch. Preflight must not send an operator down the
# rebuild path for it.
fresh_env; with_chain
mkdir -p "$STUB_CACHE_DIR/state/v28/testnet"
STUB_TIP_FAIL_ONCE="$T/tip-failed-once" ZSNAP_PREFLIGHT_WAIT=1 TMPDIR="$T" bash "$EXPORT" preflight > "$T/pf-transient.log" 2>&1
check "transient open failure retries to GO, not NO-GO" "[ $? -eq 0 ] && grep -q 'GO: the export binary opened' '$T/pf-transient.log'"
check "and says it is retrying" "grep -q 'retrying in' '$T/pf-transient.log'"
check "never claims NO-GO on a transient" "! grep -q 'NO-GO' '$T/pf-transient.log'"

fresh_env; with_chain
mkdir -p "$STUB_CACHE_DIR/state/v28/testnet"
STUB_TIP_FAIL=1 ZSNAP_PREFLIGHT_TRIES=2 ZSNAP_PREFLIGHT_WAIT=1 TMPDIR="$T" bash "$EXPORT" preflight > "$T/pf-nogo.log" 2>&1
check "preflight exits nonzero when the binary cannot open it" "[ $? -ne 0 ]"
check "says NO-GO" "grep -q 'NO-GO' '$T/pf-nogo.log'"
check "NO-GO only after every attempt" "grep -q 'could not open this state in 2 attempts' '$T/pf-nogo.log'"
check "surfaces the binary's own error" "grep -q 'Opening database failed' '$T/pf-nogo.log'"
check "points at the SNAPSHOTS.md section" "grep -q 'When the export binary and the node disagree' '$T/pf-nogo.log'"

fresh_env
TMPDIR="$T" bash "$EXPORT" preflight > "$T/pf-novol.log" 2>&1
check "preflight without a chain volume fails clearly" "[ $? -ne 0 ] && grep -q 'z3-testnet-chain not found' '$T/pf-novol.log'"

# Preflight must work before any export has ever run, i.e. before ZSNAP_DIR
# exists. Regression for writing its scratch file into a missing directory.
fresh_env; with_chain
mkdir -p "$STUB_CACHE_DIR/state/v28/testnet"
rm -rf "$ZSNAP_DIR"
TMPDIR="$T" bash "$EXPORT" preflight > "$T/pf-fresh.log" 2>&1
check "preflight works on a box with no ZSNAP_DIR yet" "[ $? -eq 0 ]"
# Scoped to this test's own TMPDIR. Asserting against the shared /tmp made
# this fail on any runner where an unrelated zsnap-preflight.* file already
# existed, which is why it passed locally and failed in CI.
check "and leaves no scratch behind" "! ls '$T'/zsnap-preflight.* >/dev/null 2>&1"

echo "== publish: uploads the set a stranger needs, pointer last"
PUBLISH="$REPO/deploy/z3/zsnap-publish.sh"
publish_env() {
  fresh_env
  mkdir -p "$ZSNAP_DIR/snapshots" "$T/remote"
  printf '#!/usr/bin/env bash\nset -e\ncp "$1" "$2"\necho "up $(basename "$1")" >> %q\n' "$T/uploads.log" > "$T/upcmd"
  chmod +x "$T/upcmd"
  export ZSNAP_PUBLISH_CMD="$T/upcmd" ZSNAP_PUBLISH_BASE="$T/remote"
  : > "$T/uploads.log"
}
mksnap() { # $1 height
  local n="zsnap-testnet-$1-deadbeefcafe.tar.zst"
  echo "archive-bytes-$1" > "$ZSNAP_DIR/snapshots/$n"
  echo "deadbeefcafe0123456789" > "$ZSNAP_DIR/snapshots/$n.manifest-hash"
  echo "$ZSNAP_DIR/snapshots/$n"
}

publish_env
snap="$(mksnap 4204800)"
bash "$PUBLISH" > "$T/pub.log" 2>&1
check "publish exits 0" "[ $? -eq 0 ]"
check "archive uploaded" "[ -f '$T/remote/zsnap-testnet-4204800-deadbeefcafe.tar.zst' ]"
check "manifest hash uploaded" "[ -f '$T/remote/zsnap-testnet-4204800-deadbeefcafe.tar.zst.manifest-hash' ]"
check "sha256 uploaded" "[ -f '$T/remote/zsnap-testnet-4204800-deadbeefcafe.tar.zst.sha256' ]"
check "pointer uploaded" "[ -f '$T/remote/latest-testnet.txt' ]"
check "pointer names the file" "grep -qx 'file=zsnap-testnet-4204800-deadbeefcafe.tar.zst' '$T/remote/latest-testnet.txt'"
check "pointer carries the height" "grep -qx 'height=4204800' '$T/remote/latest-testnet.txt'"
check "pointer carries the manifest hash" "grep -qx 'manifest_hash=deadbeefcafe0123456789' '$T/remote/latest-testnet.txt'"
check "pointer sha matches the archive" "[ \"\$(grep '^sha256=' '$T/remote/latest-testnet.txt' | cut -d= -f2)\" = \"\$(sha256sum '$snap' | cut -d' ' -f1)\" ]"
# A pointer naming a half-uploaded archive is worse than a stale pointer.
check "pointer uploaded LAST" "[ \"\$(tail -n1 '$T/uploads.log')\" = 'up latest-testnet.txt' ]"

echo "== publish: picks the newest snapshot when not told which"
publish_env
mksnap 4204700 >/dev/null; sleep 1.1; mksnap 4204900 >/dev/null
bash "$PUBLISH" > /dev/null 2>&1
check "newest height published" "grep -qx 'height=4204900' '$T/remote/latest-testnet.txt'"

echo "== publish: refusals"
publish_env
snap="$(mksnap 4204800)"; rm -f "$snap.manifest-hash"
bash "$PUBLISH" > "$T/nohash.log" 2>&1
check "no sidecar -> refuses" "[ $? -ne 0 ] && grep -q 'nothing to verify against' '$T/nohash.log'"
check "and uploaded nothing" "[ -z \"\$(ls -A '$T/remote')\" ]"

publish_env
mksnap 4204800 >/dev/null
ZSNAP_PUBLISH_CMD='' bash "$PUBLISH" > "$T/nocmd.log" 2>&1
check "no upload command -> refuses" "[ $? -ne 0 ] && grep -q 'ZSNAP_PUBLISH_CMD is not set' '$T/nocmd.log'"

publish_env
bash "$PUBLISH" > "$T/nosnap.log" 2>&1
check "no snapshot at all -> clear error" "[ $? -ne 0 ] && grep -q 'run an export first' '$T/nosnap.log'"

echo "== publish: --dry-run needs no config and uploads nothing"
publish_env
mksnap 4204800 >/dev/null
ZSNAP_PUBLISH_CMD='' ZSNAP_PUBLISH_BASE='' bash "$PUBLISH" --dry-run > "$T/dry.log" 2>&1
check "dry run exits 0 without config" "[ $? -eq 0 ]"
check "dry run shows the pointer it would write" "grep -q 'manifest_hash=' '$T/dry.log'"
check "dry run uploaded nothing" "[ -z \"\$(ls -A '$T/remote')\" ]"

echo "== publish: a failed upload does not leave a pointer behind"
publish_env
mksnap 4204800 >/dev/null
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/upcmd"   # every upload fails
bash "$PUBLISH" > "$T/upfail.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "says nothing was published" "grep -q 'nothing was published' '$T/upfail.log'"
check "no pointer in the remote" "[ ! -f '$T/remote/latest-testnet.txt' ]"

echo "== export: a transient un-ready waits instead of losing the whole cycle"
# One un-ready probe used to die and cost a 6h cycle. STUB_READY_MAX makes the
# gate fail its first probes and then pass, as a burst-lagging node does.
fresh_env; with_chain
STUB_READY_FAIL_UNTIL="$T/ready-after" ZSNAP_READY_WAIT=1 bash "$EXPORT" > "$T/tready.log" 2>&1
check "export still succeeds" "[ $? -eq 0 ]"
check "says it is retrying, not refusing" "grep -q 'zebra not ready, probe 1/' '$T/tready.log'"
check "notes when it became ready" "grep -q 'became ready after' '$T/tready.log'"
check "never claims a stale snapshot refusal" "! grep -q 'refusing a stale snapshot' '$T/tready.log'"

echo "== export: a genuinely un-ready node still refuses, after waiting"
fresh_env; with_chain
STUB_READY=0 ZSNAP_READY_TRIES=2 ZSNAP_READY_WAIT=1 bash "$EXPORT" > "$T/nready.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "refusal names the probe count" "grep -q 'not ready in 2 probes' '$T/nready.log'"
check "no export attempted" "! grep -q 'zebrad export-snapshot' '$STUB_LOG'"
