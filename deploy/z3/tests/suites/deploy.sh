# shellcheck shell=bash
# deploy.sh bring-up: ordering, the one-time wallet init, idempotent re-runs.
# Sourced by run-tests.sh; uses deploy_fresh_env and the deploy-stubs docker.

echo "== fresh box: site first, manual faucet-web retired, account wired after sync"
deploy_fresh_env
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
# Portable in-place edit: `sed -i` takes a backup suffix on BSD/macOS, so the
# GNU no-suffix form fails there and leaves the file unchanged (#160). Write to
# a temp and move instead, which behaves the same on both.
sed 's/^RATE_LIMIT_SALT=.*/RATE_LIMIT_SALT=a-real-salt/' "$D/z3/faucet.env" > "$D/z3/faucet.env.tmp" \
  && mv "$D/z3/faucet.env.tmp" "$D/z3/faucet.env"
run_deploy > "$T/run3.log" 2>&1
check "salt-fixed re-run exits 0" "[ $? -eq 0 ]"
check "no salt nag once set" "! grep -q 'RATE_LIMIT_SALT' '$T/run3.log'"
echo "== miner address: a wrong one loses funds silently, so deploy refuses it"
# The node mines, blocks are found, and the reward is unspendable or belongs to a
# stranger. Nothing errors. So the real safety property is not just a nonzero
# exit: the override must NOT exist afterwards, because a written file is a box
# that mines to the wrong place.
GOOD_ADDR="tmUiVxo1bbZLP5z6KYfM4dh3PcX5wkd7on8"

deploy_fresh_env
FAUCET_MINER_ADDRESS="$GOOD_ADDR" run_deploy > "$T/good.log" 2>&1
check "a valid testnet address is accepted" "[ $? -eq 0 ]"
check "and the override carries it" \
  "grep -q 'ZEBRA_MINING__MINER_ADDRESS: \"$GOOD_ADDR\"' '$D/z3-stack/docker-compose.override.yml'"
check "and the file says not to hand-edit it" \
  "grep -q 'GENERATED by deploy/deploy.sh' '$D/z3-stack/docker-compose.override.yml'"

# A typo that keeps the right prefix AND length is the likeliest real mistake,
# and the checksum is the only thing that catches it.
deploy_fresh_env
FAUCET_MINER_ADDRESS="tmUiVxo1bbZLP5z6KYfM4dh3PcX5wkd7on9" run_deploy > "$T/typo.log" 2>&1
check "a typo'd address is refused" "[ $? -ne 0 ]"
check "and is named as a checksum failure, not something vague" "grep -q 'checksum' '$T/typo.log'"
check "and NO override is written" "[ ! -f '$D/z3-stack/docker-compose.override.yml' ]"

deploy_fresh_env
FAUCET_MINER_ADDRESS="t1UiVxo1bbZLP5z6KYfM4dh3PcX5wkd7on8" run_deploy > "$T/mainnet.log" 2>&1
check "a mainnet address on a testnet box is refused" "[ $? -ne 0 ]"
check "and says WRONG NETWORK" "grep -q 'WRONG NETWORK' '$T/mainnet.log'"
check "and explains the reward would be unspendable" "grep -q 'unspendable' '$T/mainnet.log'"
check "and NO override is written" "[ ! -f '$D/z3-stack/docker-compose.override.yml' ]"

# Pasting the faucet's OWN unified address is the mistake most likely to happen,
# so it gets the coinbase explanation rather than a base58 complaint.
deploy_fresh_env
FAUCET_MINER_ADDRESS="utest17rnhex9h0grncus4ax40w2xkmvhz843mvp6" run_deploy > "$T/shielded.log" 2>&1
check "a unified address is refused" "[ $? -ne 0 ]"
check "and says a coinbase can only pay a transparent address" \
  "grep -q 'only pay a TRANSPARENT address' '$T/shielded.log'"
check "and does NOT blame base58" "! grep -q 'not base58' '$T/shielded.log'"

# The value is written inside YAML quotes, so a quote would escape into structure.
deploy_fresh_env
FAUCET_MINER_ADDRESS='tm" ; rm -rf /nonexistent ; echo "' run_deploy > "$T/inject.log" 2>&1
check "a value that would escape the YAML is refused" "[ $? -ne 0 ]"
check "and NO override is written" "[ ! -f '$D/z3-stack/docker-compose.override.yml' ]"

# An unset variable must not be an error: a box can serve without mining.
deploy_fresh_env
run_deploy > "$T/unset.log" 2>&1
check "an unset miner address is not an error" "[ $? -eq 0 ]"
check "but it says the faucet will not mine" "grep -q 'will not mine' '$T/unset.log'"
