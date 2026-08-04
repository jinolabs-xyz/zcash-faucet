# shellcheck shell=bash
# zsnap-export.sh and zsnap-import.sh. Sourced by run-tests.sh, which
# provides the helpers in lib.sh and the EXPORT/IMPORT paths.

echo "== export hot (default): three generations kept, the fourth rotates S1 out"
fresh_env; with_chain
for i in 1 2 3 4; do
  sed "s/3652108/365210$i/" "$SCRATCH/stubs/zebrad-stub" > "$T/zebrad-$i" && chmod +x "$T/zebrad-$i"
  ZSNAP_ZEBRAD="$T/zebrad-$i" bash "$EXPORT" > "$T/export-$i.log" 2>&1 || bad "export run $i exited $? (see $T/export-$i.log)"
done
n_archives="$(find "$ZSNAP_DIR/snapshots" -name 'zsnap-testnet-*.tar.zst' | wc -l | tr -d ' ')"
check "three generations kept (got $n_archives)" "[ '$n_archives' = '3' ]"
check "S1 rotated out when S4 landed" "! find '$ZSNAP_DIR/snapshots' -name '*3652101*' | grep -q ."
check "S2, S3, S4 all still present" "[ \"\$(find '$ZSNAP_DIR/snapshots' -name '*365210[234]*.tar.zst' | wc -l | tr -d ' ')\" = '3' ]"
# NOT DERIVED FROM sha256 OF THE MANIFEST BYTES ANY MORE, and that is the whole of #404.
# These two used to compute `sha256('{"stub":true}')` and demand the exporter agree. The
# stub reported that, the production check compared against that, and both were wrong
# about zebrad, which hashes a canonical text with a personalized BLAKE2b. Two fixtures
# agreeing with each other while both differ from the real thing - so the suite stayed
# green for two days while every export on the live box was rejected.
#
# The relationship is asserted instead: whatever identity the exporter recorded, the
# archive NAME carries its first twelve characters and the sidecar carries all of it.
# That holds for any correct hash function and cannot be satisfied by agreeing with a
# fixture, because the value now comes from the stub computing zebrad's real function.
check "latest symlink points at the newest height" \
  "[ \"\$(readlink '$ZSNAP_DIR/snapshots/latest.tar.zst')\" = \"zsnap-testnet-3652104-\$(cut -c1-12 < '$ZSNAP_DIR/snapshots/latest.manifest-hash').tar.zst\" ]"
check "sidecar has the FULL manifest hash, not the truncated name form" \
  "[ \"\$(wc -c < '$ZSNAP_DIR/snapshots/latest.manifest-hash' | tr -d ' ')\" = '65' ]"
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

echo "== import: walks generations newest to oldest, genesis only after all fail"
mkgen() { # $1 dir, $2 height, $3 good|corrupt
  local d="$1" n="zsnap-testnet-$2-deadbeefcafe.tar.zst"
  mkdir -p "$d/g$2/snapshot"; echo '{"stub":true}' > "$d/g$2/snapshot/MANIFEST.json"
  ( cd "$d/g$2" && tar -cf - snapshot | zstd -q -o "$d/$n" )
  echo "deadbeefcafe0123" > "$d/$n.manifest-hash"
  if [ "$3" = "corrupt" ]; then
    # Break the payload but keep a sha256 that matches, so the failure has to
    # be caught by unpacking, not only by the checksum.
    printf 'not a zstd stream' > "$d/$n"
  fi
  sha256sum "$d/$n" | cut -d' ' -f1 > "$d/$n.sha256"
  rm -rf "$d/g$2"
}

# Newest is corrupt, middle is good: it must fall through exactly one layer.
fresh_env
mkdir -p "$T/gens"
mkgen "$T/gens" 100 good; sleep 1.1
mkgen "$T/gens" 200 good; sleep 1.1
mkgen "$T/gens" 300 corrupt
bash "$IMPORT" "$T/gens" > "$T/walk.log" 2>&1
check "import succeeds by falling back" "[ $? -eq 0 ]"
check "saw three candidates" "grep -q '3 candidate(s) to try' '$T/walk.log'"
check "tried the newest first" "grep -q 'generation 1/3: zsnap-testnet-300' '$T/walk.log'"
check "announced the failure loudly" "grep -q 'GENERATION 1 FAILED' '$T/walk.log'"
check "fell through to the next older" "grep -q 'generation 2/3: zsnap-testnet-200' '$T/walk.log'"
check "did not reach the oldest" "! grep -q 'generation 3/3' '$T/walk.log'"
check "state was imported" "[ -f '$STUB_CACHE_DIR/state/v27/testnet/db.stub' ]"

# All three corrupt: genesis fallback, and it must say so rather than pretend.
fresh_env
mkdir -p "$T/gens"
for h in 100 200 300; do mkgen "$T/gens" $h corrupt; sleep 1.1; done
bash "$IMPORT" "$T/gens" > "$T/allfail.log" 2>&1
check "exits nonzero so the boot path falls back to genesis" "[ $? -ne 0 ]"
check "tried all three" "grep -q 'generation 3/3' '$T/allfail.log'"
check "says every generation failed" "grep -q 'all 3 generation(s) failed' '$T/allfail.log'"
check "names genesis as the consequence" "grep -q 'sync from genesis' '$T/allfail.log'"
check "left no partial state behind" "[ ! -d '$STUB_CACHE_DIR/state' ]"

# A checksum mismatch is caught before unpacking.
fresh_env
mkdir -p "$T/gens"; mkgen "$T/gens" 400 good
printf '%064d' 0 > "$T/gens/zsnap-testnet-400-deadbeefcafe.tar.zst.sha256"
bash "$IMPORT" "$T/gens" > "$T/sha.log" 2>&1
check "sha mismatch is reported as corruption" "grep -q 'sha256 mismatch' '$T/sha.log'"

# An explicit argument is one candidate, not a walk.
fresh_env
mkdir -p "$T/gens"; mkgen "$T/gens" 500 good; mkgen "$T/gens" 600 good
bash "$IMPORT" "$T/gens/zsnap-testnet-600-deadbeefcafe.tar.zst" > "$T/one.log" 2>&1
check "explicit archive is a single candidate" "grep -q '1 candidate(s) to try' '$T/one.log'"

echo "== import: a pinned hash cannot break the fallback chain (SDE-App's HIGH)"
# ZSNAP_EXPECT_HASH is the DOCUMENTED path. Applying it to every generation
# verified gen 2 against gen 1's hash, so the walk could never succeed and the
# log blamed the archives rather than the pin.
fresh_env
mkdir -p "$T/gens"
mkgen "$T/gens" 700 good; sleep 1.1
mkgen "$T/gens" 800 corrupt
ZSNAP_EXPECT_HASH="hash-that-only-matches-generation-1" bash "$IMPORT" "$T/gens" > "$T/pin.log" 2>&1
check "the walk still succeeds with a pin set" "[ $? -eq 0 ]"
check "says the pin is ignored for a chain" "grep -q 'per-generation hashes are used instead' '$T/pin.log'"
check "the pin was NOT passed to the surviving generation" "! grep -q -- '--expect-hash hash-that-only-matches-generation-1' '$STUB_LOG'"
check "the good generation was imported" "[ -f '$STUB_CACHE_DIR/state/v27/testnet/db.stub' ]"

# One candidate: the pin is exactly what it is for, so it must still apply.
fresh_env
mkdir -p "$T/gens"; mkgen "$T/gens" 900 good
ZSNAP_EXPECT_HASH="pinned-for-one" bash "$IMPORT" "$T/gens/zsnap-testnet-900-deadbeefcafe.tar.zst" > "$T/pin1.log" 2>&1
check "a single candidate still honours the pin" "grep -q -- '--expect-hash pinned-for-one' '$STUB_LOG'"
check "and does not warn about a chain" "! grep -q 'per-generation hashes' '$T/pin1.log'"

echo "== import: the published-pointer path, exercised end to end"
# The previous test for this REIMPLEMENTED the parsing loop and its copy
# omitted the guard that caused the bug, so it passed while production dropped
# the newest generation. This serves a real pointer and real archives over HTTP
# and runs zsnap-import.sh, so only the shipped code decides the result.
fresh_env
mkdir -p "$T/pub"
for h in 100 200 300; do
  mkdir -p "$T/build/snapshot"; echo '{"stub":true}' > "$T/build/snapshot/MANIFEST.json"
  ( cd "$T/build" && tar -cf - snapshot | zstd -q -o "$T/pub/zsnap-testnet-$h-deadbeefcafe.tar.zst" )
  echo "hash-$h" > "$T/pub/zsnap-testnet-$h-deadbeefcafe.tar.zst.manifest-hash"
  rm -rf "$T/build"
done
# Newest first, exactly the format zsnap-publish.sh writes: file= then fileN=.
{
  echo "file=zsnap-testnet-300-deadbeefcafe.tar.zst"
  echo "height=300"
  echo "manifest_hash=hash-300"
  echo "file2=zsnap-testnet-200-deadbeefcafe.tar.zst"
  echo "manifest_hash2=hash-200"
  echo "file3=zsnap-testnet-100-deadbeefcafe.tar.zst"
  echo "manifest_hash3=hash-100"
} > "$T/pub/latest-testnet.txt"

PUB_PORT=$((18940 + (RANDOM % 40)))
( cd "$T/pub" && python3 -m http.server "$PUB_PORT" --bind 127.0.0.1 ) >/dev/null 2>&1 &
PUB_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:$PUB_PORT/latest-testnet.txt" && break; sleep 0.25; done

bash "$IMPORT" "http://127.0.0.1:$PUB_PORT/latest-testnet.txt" > "$T/ptr.log" 2>&1
check "pointer restore succeeds" "[ $? -eq 0 ]"
check "ALL THREE generations were collected, newest included" "grep -q '3 candidate(s) to try' '$T/ptr.log'"
check "the newest (file=, no digits) is generation 1" "grep -q 'generation 1/3: zsnap-testnet-300' '$T/ptr.log'"
check "its own hash was used, not another generation's" "grep -q -- '--expect-hash hash-300' '$STUB_LOG'"
check "no older generation was needed" "! grep -q 'generation 2/3' '$T/ptr.log'"

# And the pairing must hold deeper in the chain: break the newest, the walk
# must use generation 2's OWN hash.
fresh_env
cp -r "$T/../$(basename "$T")/pub" "$T/pub" 2>/dev/null || { mkdir -p "$T/pub"; }
for h in 100 200 300; do
  mkdir -p "$T/build/snapshot"; echo '{"stub":true}' > "$T/build/snapshot/MANIFEST.json"
  ( cd "$T/build" && tar -cf - snapshot | zstd -q -o "$T/pub/zsnap-testnet-$h-deadbeefcafe.tar.zst" )
  echo "hash-$h" > "$T/pub/zsnap-testnet-$h-deadbeefcafe.tar.zst.manifest-hash"
  rm -rf "$T/build"
done
printf 'not a zstd stream' > "$T/pub/zsnap-testnet-300-deadbeefcafe.tar.zst"
{
  echo "file=zsnap-testnet-300-deadbeefcafe.tar.zst"
  echo "manifest_hash=hash-300"
  echo "file2=zsnap-testnet-200-deadbeefcafe.tar.zst"
  echo "manifest_hash2=hash-200"
} > "$T/pub/latest-testnet.txt"
PUB_PORT2=$((PUB_PORT + 1))
( cd "$T/pub" && python3 -m http.server "$PUB_PORT2" --bind 127.0.0.1 ) >/dev/null 2>&1 &
PUB_PID2=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:$PUB_PORT2/latest-testnet.txt" && break; sleep 0.25; done
bash "$IMPORT" "http://127.0.0.1:$PUB_PORT2/latest-testnet.txt" > "$T/ptr2.log" 2>&1
check "falls back when the newest is corrupt" "[ $? -eq 0 ]"
check "generation 2 was verified with ITS hash" "grep -q -- '--expect-hash hash-200' '$STUB_LOG'"
check "not with the newest generation's hash" "! grep -q -- '--expect-hash hash-300' '$STUB_LOG'"
kill "$PUB_PID" "$PUB_PID2" 2>/dev/null

echo "== import: a pointer without a trailing newline keeps its oldest generation"
# read -r drops a final unterminated line, which silently lost a generation.
# Served without a trailing newline, and counted by the SHIPPED parser via the
# script's own log line rather than by a copy of the loop.
fresh_env
mkdir -p "$T/pub2"
for h in 10 20 30; do
  mkdir -p "$T/b/snapshot"; echo '{"stub":true}' > "$T/b/snapshot/MANIFEST.json"
  ( cd "$T/b" && tar -cf - snapshot | zstd -q -o "$T/pub2/zsnap-testnet-$h-deadbeefcafe.tar.zst" )
  echo "h$h" > "$T/pub2/zsnap-testnet-$h-deadbeefcafe.tar.zst.manifest-hash"; rm -rf "$T/b"
done
printf 'file=zsnap-testnet-30-deadbeefcafe.tar.zst\nmanifest_hash=h30\nfile2=zsnap-testnet-20-deadbeefcafe.tar.zst\nmanifest_hash2=h20\nfile3=zsnap-testnet-10-deadbeefcafe.tar.zst\nmanifest_hash3=h10' > "$T/pub2/latest-testnet.txt"
PUB_PORT3=$((18990 + (RANDOM % 8)))
( cd "$T/pub2" && python3 -m http.server "$PUB_PORT3" --bind 127.0.0.1 ) >/dev/null 2>&1 &
PUB_PID3=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:$PUB_PORT3/latest-testnet.txt" && break; sleep 0.25; done
bash "$IMPORT" "http://127.0.0.1:$PUB_PORT3/latest-testnet.txt" > "$T/ptr3.log" 2>&1
check "the shipped parser reads all three from an unterminated pointer" "grep -q '3 candidate(s) to try' '$T/ptr3.log'"
kill "$PUB_PID3" 2>/dev/null

# ── the snapshot is proven to open, BEFORE it is published ──────────────────────
# This used to repoint `latest` and rotate before anything read the archive back, so a
# snapshot truncated by a full disk would become `latest` and could evict the last good
# one. The failure would surface at import, while someone is rebuilding a box.

echo "== zsnap-export: a good export says it verified, and publishes"
fresh_env; with_chain
bash "$EXPORT" > "$T/vok.log" 2>&1
check "a verified export exits 0" "[ $? -eq 0 ]"
# The old line said "verified: decompresses, and its manifest matches", which described
# a check that could not pass and never did. What the log has to carry now is what was
# actually examined, so an operator reading it knows the payload was opened and not just
# the manifest read.
check "it says how many chunks it checked, not just that something verified" \
  "grep -qE 'verified: [0-9]+ chunks, each present with the listed size and content hash' '$T/vok.log'"
check "and that the identity matched what zebrad reported" \
  "grep -q 'matches what zebrad reported' '$T/vok.log'"
check "and the done line carries it" "grep -qE 'done: .*verified$' '$T/vok.log'"
check "and latest points at the new snapshot" \
  "[ -L '$ZSNAP_DIR/snapshots/latest.tar.zst' ]"

echo "== zsnap-export: a manifest that does not match FAILS and latest is NOT moved"
# The ordering is the point. A bad snapshot must not become the one a rebuild reaches for.
fresh_env; with_chain
bash "$EXPORT" > /dev/null 2>&1
before="$(readlink "$ZSNAP_DIR/snapshots/latest.tar.zst" 2>/dev/null)"
STUB_MANIFEST_MISMATCH=1 bash "$EXPORT" > "$T/vbad.log" 2>&1
check "an export whose manifest does not match FAILS" "[ $? -ne 0 ]"
check "and says the importer would refuse it" \
  "grep -q 'zsnap-import authenticates against this hash' '$T/vbad.log'"
check "the bad archive is KEPT as evidence, renamed" \
  "ls '$ZSNAP_DIR/snapshots/'*.unverified >/dev/null 2>&1"
check "LATEST STILL POINTS AT THE GOOD SNAPSHOT" \
  "[ \"\$(readlink '$ZSNAP_DIR/snapshots/latest.tar.zst')\" = \"$before\" ]"
check "and the bad one has no manifest-hash sidecar to make it look publishable" \
  "! ls '$ZSNAP_DIR/snapshots/'*.unverified.manifest-hash >/dev/null 2>&1"
check "and a note is left, which survives even if the payload is ever dropped" \
  "ls '$ZSNAP_DIR/snapshots/'*.unverified.txt >/dev/null 2>&1"
# Asserted to exist above, so this is not vacuous. The same pair of assertions in the
# backup suite WAS vacuous until I checked existence first.
check "and the note names WHICH check failed, not just that one did" \
  "grep -q 'failed check: manifest-hash-mismatch' '$ZSNAP_DIR/snapshots/'*.unverified.txt"

echo "== zsnap-export: kept failures are BOUNDED AT ONE, or a full disk feeds itself"
# App's catch. Rotation globs *.tar.zst, so a .unverified is never swept. The commonest
# cause of a bad snapshot is a full disk, so keeping every failure means a disk-full event
# permanently consumes disk with the evidence OF the disk-full event, making the next one
# likelier and its evidence bigger. A feedback loop on a timer, on multi-GB files.
fresh_env; with_chain
bash "$EXPORT" > /dev/null 2>&1
STUB_MANIFEST_MISMATCH=1 bash "$EXPORT" > /dev/null 2>&1
# A `first_note=` capture used to sit here, never compared to anything, and broken twice
# over: '$ZSNAP_DIR' was single-quoted inside a live command substitution, so it listed a
# literal directory named $ZSNAP_DIR and the variable was empty regardless.
#
# It read like a missing assertion, and I assumed it was one. The archive name is
# zsnap-$NETWORK-$height-${hash:0:12} with no timestamp, so I expected two consecutive
# failure runs to collide on one name and the two counts below to hold by overwrite whether
# or not the sweep at zsnap-export.sh:400 exists - which would have made this whole block
# unfalsifiable, on App's unbounded-failures catch.
#
# MEASURED INSTEAD OF FIXED. Deleted the sweep and ran the suite: 147 passed, 2 failed, both
# of them these two. The names do differ between the runs, the block catches exactly what it
# claims, and the capture was only ever dead code. Removed rather than completed, and this
# note is here so the next person does not re-add an assertion the suite already makes.
STUB_MANIFEST_MISMATCH=1 bash "$EXPORT" > /dev/null 2>&1
check "two failures in a row leave exactly ONE kept archive" \
  "[ \"\$(ls '$ZSNAP_DIR/snapshots/'*.tar.zst.unverified 2>/dev/null | wc -l | tr -d ' ')\" = '1' ]"
check "and exactly one note" \
  "[ \"\$(ls '$ZSNAP_DIR/snapshots/'*.unverified.txt 2>/dev/null | wc -l | tr -d ' ')\" = '1' ]"

echo "== zsnap-export: KEEP=0 is refused before it can delete this run's own snapshot"
fresh_env; with_chain
ZSNAP_KEEP=0 bash "$EXPORT" > "$T/k0.log" 2>&1
check "KEEP=0 exits nonzero" "[ $? -ne 0 ]"
check "and says rotation would delete the snapshot this run just made" \
  "grep -q 'would delete the snapshot this run just made' '$T/k0.log'"
check "and it is the guard talking, not a command-not-found" \
  "! grep -q 'command not found' '$T/k0.log'"

# ── THE VERIFIER ITSELF, AGAINST ARCHIVES BUILT TO FAIL ─────────────────────────────
#
# The check this replaces had no test that could tell a working verifier from a broken
# one. It compared sha256 of MANIFEST.json against zebrad's hash - two unrelated
# quantities - and the stub was written to the same wrong belief, so the pair agreed and
# the suite was green while every export on the live box was rejected for two days (#404).
#
# So these drive `zsnap-export.sh --verify-only` against hand-built archives whose faults
# are known, through the production code path rather than a copy of it. Every one of them
# went red against the old implementation, which is the only reason to trust them.
echo "== verify: a well-formed archive verifies, and each way of breaking one is caught"
mk_scratch "${TMPDIR:-/tmp}/zsnap-verify.XXXXXX"
VDIR="$T/v"; mkdir -p "$VDIR/snapshot/chunks"

# Built here rather than by the stub, because these need faults the stub must never have.
head -c 65536 /dev/urandom > "$VDIR/snapshot/chunks/hash_by_height.zsnap"
head -c 4096  /dev/urandom > "$VDIR/snapshot/chunks/block_info.zsnap"
VHASH="$(VD="$VDIR" python3 - <<'PY'
import hashlib, json, os
P = b"ZebraSnapshotV1"
vd = os.environ["VD"]
def h(b): return hashlib.blake2b(b, digest_size=32, person=P).hexdigest()
chunks = []
for name, fn in (("hash_by_height", "hash_by_height.zsnap"), ("block_info", "block_info.zsnap")):
    d = open(os.path.join(vd, "snapshot/chunks", fn), "rb").read()
    chunks.append({"name": name, "file": "chunks/" + fn, "records": len(d)//100,
                   "bytes": len(d), "blake2b256": h(d)})
man = {"snapshot_format": 2, "db_format_version": "28.0.0", "network": "Testnet",
       "tip_height": 4236099, "tip_hash": "00b57128", "chunks": chunks}
json.dump(man, open(os.path.join(vd, "snapshot/MANIFEST.json"), "w"), indent=2)
s = "zsnap-canonical-v2\n"
for k in ("network","tip_height","tip_hash","db_format_version","snapshot_format"):
    s += "%s=%s\n" % (k, man[k])
for c in sorted((c for c in chunks if c["name"] != "block_info"), key=lambda c: c["name"]):
    s += "chunk=%s,%s,%s,%s\n" % (c["name"], c["records"], c["bytes"], c["blake2b256"])
print(h(s.encode()))
PY
)"
mkv() { tar -C "$VDIR" -cf - snapshot | zstd -q -o "$1"; }   # $1 archive path
mkv "$T/good.tar.zst"

bash "$EXPORT" --verify-only "$T/good.tar.zst" "$VHASH" > "$T/vgood.log" 2>&1
check "a well-formed archive verifies" "[ $? -eq 0 ]"
check "and it says how many chunks it actually checked" "grep -qE '2 chunks' '$T/vgood.log'"

# THE CONTROL FOR THE BUG. block_info is excluded from the identity, so if that exclusion
# were dropped the hash above would not be reachable at all.
check "the identity is not the sha256 of MANIFEST.json, which is what shipped" \
  "[ \"\$(sha256sum '$VDIR/snapshot/MANIFEST.json' | cut -d' ' -f1)\" != '$VHASH' ]"

bash "$EXPORT" --verify-only "$T/good.tar.zst" "0000000000000000000000000000000000000000000000000000000000000000" > "$T/vwrong.log" 2>&1
check "a wrong expected hash is refused" "[ $? -ne 0 ]"
check "and the reason names the mismatch" "grep -q 'manifest-hash-mismatch' '$T/vwrong.log'"
check "and it says the payload was intact, so nobody re-exports for nothing" \
  "grep -q 'PAYLOAD is intact' '$T/vwrong.log'"

# A CHUNK WITH ONE BYTE CHANGED. The old check never opened a chunk, so this passed it
# even in the world where its hash comparison had been right.
cp -r "$VDIR" "$T/vt"; printf 'x' | dd of="$T/vt/snapshot/chunks/hash_by_height.zsnap" bs=1 seek=100 conv=notrunc 2>/dev/null
tar -C "$T/vt" -cf - snapshot | zstd -q -o "$T/tampered.tar.zst"
bash "$EXPORT" --verify-only "$T/tampered.tar.zst" "$VHASH" > "$T/vtamp.log" 2>&1
check "a chunk with one byte changed is caught" "[ $? -ne 0 ]"
check "and the reason is the chunk, not the manifest" "grep -q 'chunk-hash-mismatch' '$T/vtamp.log'"

# A TRUNCATED CHUNK, which is the disk-full case this whole step exists for.
cp -r "$VDIR" "$T/vs"; head -c 60000 "$VDIR/snapshot/chunks/hash_by_height.zsnap" > "$T/vs/snapshot/chunks/hash_by_height.zsnap"
tar -C "$T/vs" -cf - snapshot | zstd -q -o "$T/short.tar.zst"
bash "$EXPORT" --verify-only "$T/short.tar.zst" "$VHASH" > "$T/vshort.log" 2>&1
check "a truncated chunk is caught" "[ $? -ne 0 ]"
check "and it names the byte counts" "grep -q 'chunk-size-mismatch' '$T/vshort.log'"

# A MISSING CHUNK.
cp -r "$VDIR" "$T/vm"; rm -f "$T/vm/snapshot/chunks/hash_by_height.zsnap"
tar -C "$T/vm" -cf - snapshot | zstd -q -o "$T/missing.tar.zst"
bash "$EXPORT" --verify-only "$T/missing.tar.zst" "$VHASH" > "$T/vmiss.log" 2>&1
check "a chunk the manifest lists but the archive lacks is caught" "[ $? -ne 0 ]"
check "and the reason says which" "grep -q 'chunk-missing' '$T/vmiss.log'"

# NO MANIFEST AT ALL.
cp -r "$VDIR" "$T/vn"; rm -f "$T/vn/snapshot/MANIFEST.json"
tar -C "$T/vn" -cf - snapshot | zstd -q -o "$T/nomanifest.tar.zst"
bash "$EXPORT" --verify-only "$T/nomanifest.tar.zst" "$VHASH" > "$T/vnm.log" 2>&1
check "an archive with no manifest is refused" "[ $? -ne 0 ]"
check "and says so plainly" "grep -q 'no-manifest' '$T/vnm.log'"

# A TRUNCATED ARCHIVE, cut mid-stream rather than mid-file.
head -c 20000 "$T/good.tar.zst" > "$T/cut.tar.zst"
bash "$EXPORT" --verify-only "$T/cut.tar.zst" "$VHASH" > "$T/vcut.log" 2>&1
check "an archive cut off partway is refused" "[ $? -ne 0 ]"
check "and is never reported as verified" "! grep -q '^verified' '$T/vcut.log'"
