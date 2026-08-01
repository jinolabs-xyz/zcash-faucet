# shellcheck shell=bash
# redeploy.sh: build, swap, health-gate, and roll back when the new build
# does not come up. docker/curl/git are stubbed so image tags, health
# transitions and failures can be driven exactly.

REDEPLOY="$REPO/deploy/z3/redeploy.sh"

redeploy_env() {
  mk_scratch "${TMPDIR:-/tmp}/redeploy-test.XXXXXX"
  export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
  export STUB_IMAGES="$T/images"; mkdir -p "$STUB_IMAGES"
  mkdir -p "$T/bin" "$T/overlay"
  ln -sf "$SCRATCH/stubs/redeploy-docker" "$T/bin/docker"
  ln -sf "$SCRATCH/stubs/redeploy-curl"   "$T/bin/curl"
  ln -sf "$SCRATCH/stubs/redeploy-git"    "$T/bin/git"
  export PATH="$T/bin:$BASE_PATH"
  export REDEPLOY_OVERLAY_DIR="$T/overlay" REDEPLOY_REPO_DIR="$T"
  export REDEPLOY_HEALTH_TIMEOUT=6 REDEPLOY_HEALTH_INTERVAL=1
  # These tests drive the URL probe path. The container-exec default is
  # covered separately below.
  export REDEPLOY_FAUCET_URL="http://127.0.0.1:9"
  export STUB_HEALTH="$T/healthy" STUB_READY="$T/ready"
  unset STUB_BUILD_FAIL STUB_UP_FAIL STUB_PULL_FAIL 2>/dev/null
  echo "sha256:old" > "$STUB_IMAGES/zcash-faucet_latest"   # something is running
}
img() { cat "$STUB_IMAGES/$(printf '%s' "$1" | tr '/:' '__')" 2>/dev/null; }

echo "== redeploy: happy path keeps a rollback target and swaps the image"
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"       # serving before, so readiness is required after
bash "$REDEPLOY" > "$T/ok.log" 2>&1
check "redeploy exits 0" "[ $? -eq 0 ]"
check "previous image tagged before the build" "[ \"\$(img zcash-faucet:previous)\" = 'sha256:old' ]"
check "live tag now points at the new build" "[ \"\$(img zcash-faucet:latest)\" != 'sha256:old' ]"
check "readiness was required (was ready before)" "grep -q 'must be ready too' '$T/ok.log'"
check "tag happens before build" "[ \"\$(grep -n 'docker tag' '$STUB_LOG' | head -1 | cut -d: -f1)\" -lt \"\$(grep -n 'compose.*build' '$STUB_LOG' | head -1 | cut -d: -f1)\" ]"

echo "== redeploy: a build failure never touches the running faucet"
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
STUB_BUILD_FAIL=1 bash "$REDEPLOY" > "$T/bf.log" 2>&1
rc_bf=$?
# 2, not 1. Nothing was swapped and the faucet is serving, so a broken build
# must not page anyone. Exit 1 is reserved for "the faucet may be down".
check "exits 2, the non-paging code" "[ $rc_bf -eq 2 ]"
check "says the running faucet was left alone" "grep -q 'left alone' '$T/bf.log'"
check "live image unchanged" "[ \"\$(img zcash-faucet:latest)\" = 'sha256:old' ]"
check "nothing was started" "! grep -q 'compose.*up' '$STUB_LOG'"

echo "== redeploy: a build that will not start rolls back automatically"
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
# Only the first `up` fails, so the new image will not start but the rollback
# can. Failing every `up` is the harder case, covered next.
STUB_UP_FAIL_ONCE="$T/up-failed-once" bash "$REDEPLOY" > "$T/uf.log" 2>&1
rc_uf=$?
check "exits 2 (rolled back, did not ship)" "[ $rc_uf -eq 2 ]"
check "rollback was attempted" "grep -q 'rolling back' '$T/uf.log'"
check "live tag restored to the previous image" "[ \"\$(img zcash-faucet:latest)\" = 'sha256:old' ]"

echo "== redeploy: when the rollback cannot start either, exit 1 for a human"
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
STUB_UP_FAIL=1 bash "$REDEPLOY" > "$T/uf2.log" 2>&1
rc_uf2=$?
check "exits 1, not 2" "[ $rc_uf2 -eq 1 ]"
check "says it needs a human" "grep -qi 'could not start the rolled-back image' '$T/uf2.log'"

echo "== redeploy: passes the health gate but never becomes ready -> rollback"
redeploy_env
# Ready for the pre-deploy check only, so the new build is required to be
# ready and never gets there. Removing the file up front would instead make
# redeploy see a non-serving faucet and correctly relax the gate.
touch "$STUB_HEALTH" "$STUB_READY"
STUB_READY_MAX=1 bash "$REDEPLOY" > "$T/nr.log" 2>&1
rc=$?
# Exit 2 specifically: service restored, change did not ship. Exiting 0 here
# would let `redeploy.sh && echo shipped` lie about a rolled-back deploy.
check "exits 2 (rolled back, did not ship)" "[ $rc -eq 2 ]"
check "says the change did not ship" "grep -q 'did NOT ship' '$T/nr.log'"
check "says live but never ready" "grep -q 'never became ready' '$T/nr.log'"
check "rolled back to the previous image" "[ \"\$(img zcash-faucet:latest)\" = 'sha256:old' ]"
# The positive control for the two cases below: a build that is genuinely not ready,
# for a reason a rollback CAN address, must still roll back. Without this, making the
# two new cases pass by never rolling back at all would look like a fix.
check "and the ordinary not-ready case names the app's own reason" \
  "grep -q 'node syncing' '$T/nr.log'"

echo "== redeploy: a probe that never ANSWERS is not evidence against the build (#229)"
# A timeout is not a negative. better-sqlite3 is synchronous, so a wedged read makes
# readiness answer LATE rather than badly, and #234 moved the cause off the request
# path without removing the possibility. Reverting on silence lets a slow endpoint
# undo a good deploy.
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
STUB_READY_MAX=1 STUB_CURL_TIMEOUT=1 bash "$REDEPLOY" > "$T/tmo.log" 2>&1
rc=$?
check "a never-answering probe does NOT roll back" \
  "[ \"\$(img zcash-faucet:latest)\" != 'sha256:old' ]"
check "and exits 1, because a faucet nobody can probe is a page" "[ $rc -eq 1 ]"
check "and says a timeout is not a negative" "grep -q 'not a negative' '$T/tmo.log'"
# NOT grep -q 'rollback': that word is in the always-present "tagged
# zcash-faucet:previous for rollback" line, so the assertion passed whether or not the
# hint existed. Match the hint itself.
check "and offers the manual rollback rather than doing it" \
  "grep -q 'redeploy.sh rollback\|\$0 rollback' '$T/tmo.log'"

echo "== redeploy: a DATA failure is not rolled back, because code is not the cause (#229)"
# The ledger lives on a volume no deploy touches, so the previous image would meet the
# same ledger. Reverting changes only which build gets blamed, and exit 2 would say
# nobody needs paging for a faucet that 500s every claim.
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
STUB_READY_MAX=1 STUB_READY_REASON="ledger unreadable" bash "$REDEPLOY" > "$T/ledg.log" 2>&1
rc=$?
check "a ledger failure does NOT roll back" \
  "[ \"\$(img zcash-faucet:latest)\" != 'sha256:old' ]"
check "and exits 1 rather than 2, because this one needs a human" "[ $rc -eq 1 ]"
check "and says the cause is DATA, not code" "grep -q 'DATA, not code' '$T/ledg.log'"
check "and says a rollback would not have fixed it" \
  "grep -q 'would not fix this' '$T/ledg.log'"
check "and names the reason it read from the app" "grep -q 'ledger unreadable' '$T/ledg.log'"

echo "== redeploy: connection REFUSED still rolls back, it is not a timeout (#229)"
# After the deadline, refused means nothing is listening, so the build did not come up.
# I had collapsed curl 7 into 28 as "no evidence", which stopped a crash-looping build
# from ever being rolled back.
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
STUB_READY_MAX=1 STUB_CURL_RC=7 bash "$REDEPLOY" > "$T/refused.log" 2>&1
rc=$?
check "a refused connection DOES roll back" "[ \"\$(img zcash-faucet:latest)\" = 'sha256:old' ]"
# Exit 1, not 2, and that is correct for what this fixture models: STUB_CURL_RC refuses
# EVERY call, so the rolled-back image cannot be verified either. The property under
# test is that refused counts as evidence and the revert is ATTEMPTED, which the check
# above proves. Asserting 2 here would have required the old build to answer, which a
# total-refusal fixture cannot express.
check "and exits 1, because the rollback could not be verified either" "[ $rc -eq 1 ]"
check "and says nothing is listening" "grep -q 'nothing is listening' '$T/refused.log'"

echo "== redeploy: the DEFAULT no-URL path can still say NO, so rollback survives (#244)"
# The regression that mattered most in #229: with REDEPLOY_FAUCET_URL empty, which is
# the default and therefore production, probe_state used to map every in-container
# failure to cannot-tell and skip the rollback entirely.
#
# This was withdrawn once because it would not fail, and the cause was the STUB, not
# the sequence: it detected the usability probe by grepping for process.exit(0), which
# also appears in probe_state's script as if(r.ok)process.exit(0), so it answered READY
# to every probe_state call. Fixed by matching on the absence of fetch( instead.
redeploy_env
unset REDEPLOY_FAUCET_URL
export STUB_EXEC_HEALTH="$T/exechealth" STUB_EXEC_READY="$T/execready"
touch "$STUB_EXEC_HEALTH" "$STUB_EXEC_READY"
# Live throughout, ready only for the pre-deploy probe: was serving before, new build
# never gets there. A counter, not a timer, so there is no race.
STUB_EXEC_READY_MAX=1 bash "$REDEPLOY" > "$T/nourl.log" 2>&1
rc=$?
check "a failing build on the exec path DOES roll back" \
  "[ \"\$(img zcash-faucet:latest)\" = 'sha256:old' ]"
check "and exits 2, because service was restored" "[ $rc -eq 2 ]"
check "and does NOT claim the probe never answered" \
  "! grep -q 'never answered' '$T/nourl.log'"

echo "== redeploy: on the exec path a THROW is cannot-tell, so it does NOT roll back (#244)"
# The other half of the distinction. A fetch that throws is no answer, and reverting on
# it lets an unreachable app undo a good deploy. Without this case, mapping everything
# to not-ready would pass the test above.
redeploy_env
unset REDEPLOY_FAUCET_URL
export STUB_EXEC_HEALTH="$T/exechealth" STUB_EXEC_READY="$T/execready"
touch "$STUB_EXEC_HEALTH" "$STUB_EXEC_READY"
STUB_EXEC_READY_MAX=1 STUB_EXEC_THROW=1 bash "$REDEPLOY" > "$T/nourl-throw.log" 2>&1
rc=$?
check "a throwing probe does NOT roll back" \
  "[ \"\$(img zcash-faucet:latest)\" != 'sha256:old' ]"
check "and exits 1, because a faucet nobody can probe is a page" "[ $rc -eq 1 ]"
unset STUB_EXEC_READY STUB_EXEC_HEALTH STUB_EXEC_READY_MAX STUB_EXEC_THROW


echo "== redeploy: not ready beforehand means liveness-only gate (syncing node)"
redeploy_env
touch "$STUB_HEALTH"                       # live but not ready, e.g. still syncing
bash "$REDEPLOY" > "$T/lo.log" 2>&1
check "deploy succeeds anyway" "[ $? -eq 0 ]"
check "gate was liveness only" "grep -q 'liveness only' '$T/lo.log'"
check "new image kept" "[ \"\$(img zcash-faucet:latest)\" != 'sha256:old' ]"

echo "== redeploy: a failed git pull changes nothing on the box"
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
STUB_PULL_FAIL=1 bash "$REDEPLOY" > "$T/pf.log" 2>&1
rc_pf=$?
check "exits 2, the non-paging code" "[ $rc_pf -eq 2 ]"
check "says nothing changed" "grep -q 'nothing has changed' '$T/pf.log'"
check "never built" "! grep -q 'compose.*build' '$STUB_LOG'"

echo "== redeploy: --no-pull skips git entirely"
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
bash "$REDEPLOY" --no-pull > "$T/np.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "git was never called" "! grep -q '^git ' '$STUB_LOG'"

echo "== redeploy: manual rollback and status"
redeploy_env
touch "$STUB_HEALTH"
echo "sha256:prev" > "$STUB_IMAGES/zcash-faucet_previous"
bash "$REDEPLOY" rollback > "$T/rb.log" 2>&1
check "rollback exits 0" "[ $? -eq 0 ]"
check "live tag is the previous image" "[ \"\$(img zcash-faucet:latest)\" = 'sha256:prev' ]"
check "rollback gate is liveness only" "! grep -q 'must be ready' '$T/rb.log'"
bash "$REDEPLOY" status > "$T/st.log" 2>&1
check "status exits 0" "[ $? -eq 0 ]"
check "status names both images" "grep -q 'running:' '$T/st.log' && grep -q 'rollback:' '$T/st.log'"

echo "== redeploy: first deploy with nothing to roll back to says so"
redeploy_env
rm -f "$STUB_IMAGES/zcash-faucet_latest"
touch "$STUB_HEALTH"
bash "$REDEPLOY" --no-pull > "$T/first.log" 2>&1
check "first deploy exits 0" "[ $? -eq 0 ]"
check "warns there is no rollback target" "grep -q 'nothing to roll back to' '$T/first.log'"

echo "== redeploy: exit 1 is reserved for a faucet that may be down"
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
# Every `up` fails, so the new image will not start AND the rollback cannot
# either. That is the only shape that should page.
STUB_UP_FAIL=1 bash "$REDEPLOY" > "$T/page.log" 2>&1
rc_page=$?
check "exits 1 when the rollback also fails" "[ $rc_page -eq 1 ]"
check "says the faucet may be down" "grep -q 'may be down' '$T/page.log'"

redeploy_env
rm -f "$STUB_IMAGES/zcash-faucet_latest"     # first deploy, no rollback target
touch "$STUB_HEALTH" "$STUB_READY"
STUB_READY_MAX=1 bash "$REDEPLOY" --no-pull > "$T/page2.log" 2>&1
rc_page2=$?
check "exits 1 when unhealthy with nothing to roll back to" "[ $rc_page2 -eq 1 ]"
check "and says the faucet is down" "grep -qi 'faucet is down' '$T/page2.log'"

echo "== redeploy: every non-paging failure says so in the log"
# Re-run the two cheap failures in one env so the assertions target real files
# rather than globbing across earlier temp dirs.
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
STUB_BUILD_FAIL=1 bash "$REDEPLOY" > "$T/say-build.log" 2>&1
check "build failure says the change did not ship" "grep -q 'did NOT ship' '$T/say-build.log'"
check "build failure does not claim the faucet is down" "! grep -qi 'may be down' '$T/say-build.log'"
STUB_PULL_FAIL=1 bash "$REDEPLOY" > "$T/say-pull.log" 2>&1
check "pull failure says the change did not ship" "grep -q 'did NOT ship' '$T/say-pull.log'"
check "pull failure does not claim the faucet is down" "! grep -qi 'may be down' '$T/say-pull.log'"

echo "== redeploy: the default probe runs inside the container, not on the host"
redeploy_env
unset REDEPLOY_FAUCET_URL
# The stub compose records exec calls; the app port is expose-only on a real
# box, so a host-side probe would always fail.
rm -f "$T/bin/docker"   # it is a symlink into a read-only mount
printf '#!/usr/bin/env bash\necho "compose $*" >> %q\nexit 0\n' "$T/stub.log" > "$T/bin/docker"
chmod +x "$T/bin/docker"
touch "$STUB_HEALTH" "$STUB_READY"
bash "$REDEPLOY" --no-pull > "$T/exec.log" 2>&1
check "probes via docker compose exec" "grep -q 'exec -T faucet node' '$T/stub.log'"
# The URL appears inside the node -e argument, which is correct. What must
# not happen is a host-side curl to a port the overlay never publishes.
check "no host-side curl to the app port" "! grep -qE '^curl .*3000' '$T/stub.log'"

echo "== redeploy: an unprobeable app is NOT VERIFIED, never a rollback"
redeploy_env
unset REDEPLOY_FAUCET_URL
# compose succeeds for build/up but every exec fails, so the probe mechanism
# is unusable. That is not evidence the faucet is unhealthy.
rm -f "$T/bin/docker"
cat > "$T/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  *"exec -T faucet"*) exit 1 ;;
  *image*inspect*) echo "sha256:old" ;;
  *) exit 0 ;;
esac
DOCKER
chmod +x "$T/bin/docker"
bash "$REDEPLOY" --no-pull > "$T/unprobe.log" 2>&1
rc_unprobe=$?
check "exits 2, not 1" "[ $rc_unprobe -eq 2 ]"
check "says NOT VERIFIED" "grep -q 'NOT VERIFIED' '$T/unprobe.log'"
check "does not claim the faucet may be down" "! grep -q 'may be down' '$T/unprobe.log'"
check "did not roll back on an unprobeable app" "! grep -q 'rolling back' '$T/unprobe.log'"

# ── what is actually SERVING, not what the tag points at ────────────────────────
# "deployed and healthy" came from the health gate alone, and a healthy faucet is not
# evidence that the NEW code is serving. `compose up -d` compares the container spec and
# can decline to recreate, which is what left the wallet reading a config we had already
# rewritten (#278). Downstream everything looks perfect: the OLD build answers every probe.

echo "== redeploy: a deploy that did not replace the container FAILS instead of claiming success"
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
echo "sha256:old" > "$STUB_IMAGES/zcash-faucet_latest"
echo "sha256:old" > "$STUB_IMAGES/.running"
STUB_UP_NO_RECREATE=1 bash "$REDEPLOY" > "$T/norecreate.log" 2>&1
check "a deploy that shipped nothing does NOT exit 0" "[ $? -ne 0 ]"
check "and says the post-condition failed" "grep -q 'POST-CONDITION FAILED' '$T/norecreate.log'"
check "and names what is running against what was expected" \
  "grep -q 'running:  sha256:old' '$T/norecreate.log'"
check "and says the health gate passed on code that is not this build" \
  "grep -q 'shipped nothing' '$T/norecreate.log'"
# The point that makes this worth having: nothing else went wrong.
check "and does NOT claim deployed and healthy" \
  "! grep -q 'deployed and healthy' '$T/norecreate.log'"

echo "== redeploy: a normal deploy still reports success, so the check is not just strict"
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
echo "sha256:old" > "$STUB_IMAGES/zcash-faucet_latest"
echo "sha256:old" > "$STUB_IMAGES/.running"
bash "$REDEPLOY" > "$T/normal.log" 2>&1
check "a real deploy exits 0" "[ $? -eq 0 ]"
check "and reports deployed and healthy" "grep -q 'deployed and healthy' '$T/normal.log'"
check "and the running container is the image that was just built" \
  "[ \"\$(cat '$STUB_IMAGES/.running')\" = \"\$(cat '$STUB_IMAGES/zcash-faucet_latest')\" ]"

echo "== redeploy: an unreadable container is UNVERIFIED, not success and not failure"
# Three states. We did not learn that the wrong code is running, we learned nothing.
redeploy_env
touch "$STUB_HEALTH" "$STUB_READY"
echo "sha256:old" > "$STUB_IMAGES/zcash-faucet_latest"
echo "sha256:old" > "$STUB_IMAGES/.running"
STUB_INSPECT_FAIL=1 bash "$REDEPLOY" > "$T/unverified.log" 2>&1
rc=$?
check "an unreadable running image is UNVERIFIED, exit 2 not 1" "[ $rc -eq 2 ]"
check "and is reported as UNVERIFIED rather than as a failed deploy" \
  "grep -q 'POST-CONDITION UNVERIFIED' '$T/unverified.log'"
check "and does not claim deployed and healthy" \
  "! grep -q 'deployed and healthy' '$T/unverified.log'"

echo "== redeploy: a rollback that did not take effect is not reported as rolled back"
# In an incident "rolled back" is the sentence people act on. Liveness proves something
# answers, not that the PREVIOUS build is what answers.
redeploy_env
touch "$STUB_HEALTH"
echo "sha256:broken" > "$STUB_IMAGES/zcash-faucet_latest"
echo "sha256:broken" > "$STUB_IMAGES/.running"
echo "sha256:good"   > "$STUB_IMAGES/zcash-faucet_previous"
STUB_UP_NO_RECREATE=1 bash "$REDEPLOY" rollback > "$T/rbfail.log" 2>&1
check "a rollback that did not replace the container FAILS" "[ $? -ne 0 ]"
check "and says the faucet is answering but is not the rolled-back image" \
  "grep -q 'not the rolled-back image' '$T/rbfail.log'"
check "and does NOT say rolled back and live" "! grep -q 'rolled back and live' '$T/rbfail.log'"

echo "== redeploy: a rollback that DID take effect still reports rolled back and live"
redeploy_env
touch "$STUB_HEALTH"
echo "sha256:broken" > "$STUB_IMAGES/zcash-faucet_latest"
echo "sha256:broken" > "$STUB_IMAGES/.running"
echo "sha256:good"   > "$STUB_IMAGES/zcash-faucet_previous"
bash "$REDEPLOY" rollback > "$T/rbok.log" 2>&1
check "a real rollback exits 0" "[ $? -eq 0 ]"
check "and says rolled back and live" "grep -q 'rolled back and live' '$T/rbok.log'"
check "and the running container is the previous image" \
  "[ \"\$(cat '$STUB_IMAGES/.running')\" = 'sha256:good' ]"
