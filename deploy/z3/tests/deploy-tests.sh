#!/usr/bin/env bash
# Exercises the reworked deploy.sh against a stub docker and a pre-seeded
# fake z3 checkout. Focus: overlay before the sync wait, single owner of
# port 80, idempotent re-runs, the salt-note errexit fix.
set -uo pipefail

SCRATCH="${TEST_SCRATCH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO="${TEST_REPO:-$(cd "$SCRATCH/../../.." && pwd)}"

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ok: $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL: $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }
check_order() {
  local a b
  a="$(grep -n "$2" "$STUB_LOG" | head -1 | cut -d: -f1)"
  b="$(grep -n "$3" "$STUB_LOG" | head -1 | cut -d: -f1)"
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then ok "$1"; else bad "$1 (got '$2'@${a:-none} vs '$3'@${b:-none})"; fi
}

fresh_env() {
  T="$(mktemp -d "${TMPDIR:-/tmp}/deploy-test.XXXXXX")"
  export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
  export STUB_CONTAINERS="$T/containers"; mkdir -p "$STUB_CONTAINERS"
  export STUB_VOLROOT="$T/volumes"; mkdir -p "$STUB_VOLROOT"
  export PATH="$SCRATCH/deploy-stubs:$PATH"
  # Writable copy of deploy/ so faucet.env, .zallet-rpc-password and the
  # fake z3 checkout land outside the (read-only) repo mount.
  cp -r "$REPO/deploy" "$T/deploy"
  D="$T/deploy"
  # Pre-seed the z3 clone so `git clone` and setup-network are skipped, and
  # give it the two scripts deploy.sh calls. The readiness one logs a marker
  # so tests can assert what came before the sync wait.
  mkdir -p "$D/z3-stack/scripts" "$D/z3-stack/config/testnet"
  touch "$D/z3-stack/config/testnet/zebra.toml" "$D/z3-stack/config/testnet/zallet.toml"
  # $STUB_LOG must land literally, the stub expands it at run time.
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\necho "readiness-wait" >> "$STUB_LOG"\n' > "$D/z3-stack/scripts/check-zebra-readiness.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$D/z3-stack/scripts/setup-network.sh"
  chmod +x "$D/z3-stack/scripts/"*.sh
}
run_deploy() { NONINTERACTIVE=1 NETWORK=testnet bash "$D/deploy.sh"; }

echo "== fresh box: site first, manual faucet-web retired, account wired after sync"
fresh_env
# A hand-started faucet-web (no compose label) squatting on port 80, plus an
# unrelated hand-run container that must be left alone.
printf 'running\n\n' > "$STUB_CONTAINERS/faucet-web"
printf 'running\n\n' > "$STUB_CONTAINERS/random-tool"
run_deploy > "$T/run1.log" 2>&1
check "fresh deploy exits 0" "[ $? -eq 0 ]"
check "manual faucet-web removed" "[ ! -f '$STUB_CONTAINERS/faucet-web' ]"
check "unrelated container untouched" "[ -f '$STUB_CONTAINERS/random-tool' ]"
check_order "overlay up before the sync wait" "overlay-up" "readiness-wait"
check_order "zebra started before overlay" "docker compose --env-file .env.testnet up -d zebra" "overlay-up"
check_order "zallet only after the sync wait" "readiness-wait" "up -d zallet"
check "overlay brought up twice (early + account rewire)" "[ \"\$(grep -c '^overlay-up$' '$STUB_LOG')\" = '2' ]"
check "faucet.env has RPC password" "grep -q '^ZALLET_RPC_PASSWORD=..*' '$D/z3-stack/../z3/faucet.env'"
check "faucet.env has account uuid" "grep -q '^ZALLET_ACCOUNT=stub-uuid-1234$' '$D/z3/faucet.env'"
check "faucet.env has address" "grep -q '^ZALLET_ADDRESS=utest1stubaddress$' '$D/z3/faucet.env'"
check "salt note printed" "grep -q 'RATE_LIMIT_SALT' '$T/run1.log'"
check "overlay containers labeled and present" "[ -f '$STUB_CONTAINERS/zcash-faucet-faucet-1' ] && [ -f '$STUB_CONTAINERS/zcash-faucet-caddy-1' ]"

ZVOL_DIR() { echo "$STUB_VOLROOT/z3-testnet-zallet"; }

# The wallet-init checks only apply once deploy.sh has the init flow
# (feat/zallet-init). Skip those cleanly on branches that predate it.
HAS_INIT=0
grep -q 'generate-encryption-identity' "$REPO/deploy/deploy.sh" && HAS_INIT=1

if [ "$HAS_INIT" = "1" ]; then
echo "== fresh box: zallet wallet init runs once, in order, before zallet starts"
check "identity generated" "[ -f \"\$(ZVOL_DIR)/identity.txt\" ]"
check "init marker dropped" "[ -f \"\$(ZVOL_DIR)/.faucet-wallet-initialized\" ]"
check "exactly one seed stored" "[ \"\$(wc -l < \"\$(ZVOL_DIR)/seeds\" | tr -d ' ')\" = '1' ]"
check_order "volume chowned before identity" "vol-chown z3-testnet-zallet" "generate-encryption-identity"
check_order "identity before wallet encryption" "generate-encryption-identity" "init-wallet-encryption"
check_order "encryption before mnemonic" "init-wallet-encryption" "generate-mnemonic"
check_order "full init before zallet starts" "generate-mnemonic" "up -d zallet"
check "rpc client passes --config" "grep 'rpc z_getnewaccount' '$STUB_LOG' | grep -q -- '--config /etc/zallet/zallet.toml'"
fi

echo "== re-run on the same box is a clean no-op pass"
: > "$STUB_LOG"
# Used inside the eval'd check string below, shellcheck cannot see that.
# shellcheck disable=SC2034
env_before="$(cat "$D/z3/faucet.env")"
run_deploy > "$T/run2.log" 2>&1
check "re-run exits 0" "[ $? -eq 0 ]"
check "no container removed on re-run" "! grep -q 'docker rm' '$STUB_LOG'"
check "overlay's own faucet container survives (label guard)" "[ -f '$STUB_CONTAINERS/zcash-faucet-faucet-1' ]"
check "no second account created" "[ \"\$(grep -c 'z_getnewaccount' '$STUB_LOG')\" = '0' ]"
check "faucet.env unchanged" "[ \"\$env_before\" = \"\$(cat \"$D/z3/faucet.env\")\" ]"

if [ "$HAS_INIT" = "1" ]; then
check "wallet init skipped on re-run" "! grep -q 'generate-encryption-identity' '$STUB_LOG'"
check "still exactly one seed" "[ \"\$(wc -l < \"\$(ZVOL_DIR)/seeds\" | tr -d ' ')\" = '1' ]"

echo "== interrupted init: identity exists, no marker, resumes without stacking seeds or clobbering"
rm -f "$(ZVOL_DIR)/.faucet-wallet-initialized" "$(ZVOL_DIR)/seeds" "$(ZVOL_DIR)/recipients.txt"
: > "$STUB_LOG"
run_deploy > "$T/run-resume.log" 2>&1
check "resume exits 0" "[ $? -eq 0 ]"
check "identity generation skipped (noclobber would fail)" "! grep -q 'generate-encryption-identity' '$STUB_LOG'"
check "encryption re-initialized" "grep -q 'init-wallet-encryption' '$STUB_LOG'"
check "one seed after resume" "[ \"\$(wc -l < \"\$(ZVOL_DIR)/seeds\" | tr -d ' ')\" = '1' ]"
check "marker present after resume" "[ -f \"\$(ZVOL_DIR)/.faucet-wallet-initialized\" ]"
else
echo "== (wallet-init checks skipped, deploy.sh has no init flow on this branch)"
fi
unset HAS_INIT

echo "== re-run after the operator fixed the salt (the old errexit trap)"
sed -i 's/^RATE_LIMIT_SALT=.*/RATE_LIMIT_SALT=a-real-salt/' "$D/z3/faucet.env"
run_deploy > "$T/run3.log" 2>&1
check "salt-fixed re-run exits 0" "[ $? -eq 0 ]"
check "no salt nag once set" "! grep -q 'RATE_LIMIT_SALT' '$T/run3.log'"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
