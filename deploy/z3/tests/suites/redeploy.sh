# shellcheck shell=bash
# redeploy.sh: build, swap, health-gate, and roll back when the new build
# does not come up. docker/curl/git are stubbed so image tags, health
# transitions and failures can be driven exactly.

REDEPLOY="$REPO/deploy/z3/redeploy.sh"

redeploy_env() {
  T="$(mktemp -d "${TMPDIR:-/tmp}/redeploy-test.XXXXXX")"
  export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
  export STUB_IMAGES="$T/images"; mkdir -p "$STUB_IMAGES"
  mkdir -p "$T/bin" "$T/overlay"
  ln -sf "$SCRATCH/stubs/redeploy-docker" "$T/bin/docker"
  ln -sf "$SCRATCH/stubs/redeploy-curl"   "$T/bin/curl"
  ln -sf "$SCRATCH/stubs/redeploy-git"    "$T/bin/git"
  export PATH="$T/bin:$BASE_PATH"
  export REDEPLOY_OVERLAY_DIR="$T/overlay" REDEPLOY_REPO_DIR="$T"
  export REDEPLOY_HEALTH_TIMEOUT=6 REDEPLOY_HEALTH_INTERVAL=1
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
check "exits nonzero" "[ $? -ne 0 ]"
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
check "exits nonzero" "[ $? -ne 0 ]"
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
