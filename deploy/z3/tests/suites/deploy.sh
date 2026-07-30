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
# A fresh box must come up with a REAL salt, not a placeholder and not a note
# telling a human to go and fix it (#173). The old check asserted the NOTE, which
# is what "a deploy printing success over an unbootable env" looks like in a test.
check "fresh deploy GENERATES a real salt" \
  "grep -qE '^RATE_LIMIT_SALT=[0-9a-f]{64}$' '$D/z3/faucet.env'"
check "no placeholder salt survives a successful deploy" \
  "! grep -qiE 'RATE_LIMIT_SALT=.*(__fill_me__|change-me|changeme)' '$D/z3/faucet.env'"
check "no salt nag on a fresh box, because there is nothing to nag about" \
  "! grep -q 'set a real RATE_LIMIT_SALT' '$T/run1.log'"

# deploy.sh's placeholder list is a COPY of PLACEHOLDER_MARKERS in
# src/lib/saltGuard.ts, because a shell script cannot import TypeScript. If the two
# drift, deploy.sh blesses an env the app rejects, which is #173 again.
#
# Compared as SETS, and that detail is SDE-Infra's finding on #205. My first version
# looped over three hardcoded marker names and grepped for each in both files, which
# is a THIRD copy of the list and can only catch DELETION. Addition is the likelier
# direction, because you add a marker at the moment you discover a new template
# string: add "placeholder" to saltGuard.ts and every assertion still passed, while
# deploy.sh left RATE_LIMIT_SALT=placeholder in place for the app to reject at boot.
# The #188 shape, proving the mechanism while blind to the coverage.
#
# Read from each DECLARATION rather than grepped over the whole file, which is the
# other half of their finding: a whole-file grep reported no drift for "placeholder"
# because the PROSE COMMENT above contains that word. The comment explaining the
# mechanism satisfied the check for a marker the code does not handle, which is #177
# again.
ts_markers(){ sed -n 's/.*PLACEHOLDER_MARKERS = \[\(.*\)\].*/\1/p' "$1" | tr -d '" ' | tr ',' '\n' | sort; }
sh_markers(){ sed -n 's/.*PLACEHOLDER_MARKERS = (\(.*\)).*/\1/p'  "$1" | tr -d '" ' | tr ',' '\n' | sort; }
GUARD_MARKERS="$(ts_markers "$REPO/src/lib/saltGuard.ts")"
SHELL_MARKERS="$(sh_markers "$REPO/deploy/deploy.sh")"
# The -n guards are not decoration. If either sed stops matching because a
# declaration gets reformatted, the extraction is empty, two empty strings compare
# EQUAL, and the check passes having verified nothing.
check "both placeholder lists were actually found" \
  "[ -n \"$GUARD_MARKERS\" ] && [ -n \"$SHELL_MARKERS\" ]"
check "deploy.sh's placeholder list matches saltGuard.ts exactly, both directions" \
  "[ \"$GUARD_MARKERS\" = \"$SHELL_MARKERS\" ]"
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

echo "== re-run must NOT rotate an existing salt"
# The property that matters most here, and the one that would be silent if wrong.
# RATE_LIMIT_SALT both signs the PoW challenges AND salts the ledger
# fingerprints, so regenerating it on every deploy would invalidate every live
# challenge and effectively RESET EVERY COOLDOWN, handing everyone a fresh drip.
# Nothing would error. write_env also runs twice per deploy, so this covers the
# second call leaving the first call's work alone.
SALT_BEFORE="$(grep '^RATE_LIMIT_SALT=' "$D/z3/faucet.env")"
run_deploy > "$T/run3.log" 2>&1
check "re-run exits 0" "[ $? -eq 0 ]"
check "re-run left the generated salt EXACTLY as it was" \
  "[ \"\$(grep '^RATE_LIMIT_SALT=' '$D/z3/faucet.env')\" = \"$SALT_BEFORE\" ]"

echo "== a hand-edited placeholder salt is REPLACED, not preserved"
# saltGuard rejects change-me as well as __FILL_ME__, and the old deploy check
# only looked for its own placeholder, so this exact shape passed the deploy and
# then crash-looped the app.
#
# Portable in-place edit: `sed -i` takes a backup suffix on BSD/macOS, so the GNU
# no-suffix form fails there and leaves the file unchanged (#160). Write to a temp
# and move instead, which behaves the same on both.
sed 's/^RATE_LIMIT_SALT=.*/RATE_LIMIT_SALT=change-me-please/' "$D/z3/faucet.env" > "$D/z3/faucet.env.tmp" \
  && mv "$D/z3/faucet.env.tmp" "$D/z3/faucet.env"
run_deploy > "$T/run4.log" 2>&1
check "re-run over a placeholder exits 0" "[ $? -eq 0 ]"
check "the placeholder was replaced with a real generated salt" \
  "grep -qE '^RATE_LIMIT_SALT=[0-9a-f]{64}$' '$D/z3/faucet.env'"

echo "== deploy does not announce a faucet that is not staying up (#206)"
# The bug this pins: deploy.sh printed "the faucet is live" for having REACHED
# that line, so a fresh box could crash-loop through an entire chain sync with the
# last thing on screen saying it worked. Same shape as the watchdog announcing a
# recovery it never checked (#175).
deploy_fresh_env
STUB_FAUCET_STATE=restarting run_deploy > "$T/crashloop.log" 2>&1
check "a crash-looping faucet makes deploy exit nonzero" "[ $? -ne 0 ]"
check "and it does NOT say the faucet is live" "! grep -q 'faucet is live' '$T/crashloop.log'"
check "and it says the site is NOT serving" "grep -q 'NOT serving' '$T/crashloop.log'"
check "and it hands over the command that shows why" \
  "grep -q 'logs --tail=50 faucet' '$T/crashloop.log'"
check "and it does not blame an earlier step that really did succeed" \
  "grep -q 'Nothing above failed' '$T/crashloop.log'"

# A container in a restart loop passes THROUGH running, so one sample can land on
# the good frame. This is the case a single-sample check would call healthy, and
# it is the whole reason deploy.sh looks twice.
deploy_fresh_env
STUB_FAUCET_STATE="running restarting" run_deploy > "$T/flap.log" 2>&1
check "a faucet up on the first look and gone on the second is caught" "[ $? -ne 0 ]"
check "and that one is not announced as live either" \
  "! grep -q 'faucet is live' '$T/flap.log'"

# Positive control. Without it every check above would also pass if deploy.sh had
# simply stopped saying "the faucet is live" at all.
deploy_fresh_env
run_deploy > "$T/healthy.log" 2>&1
check "a faucet that stays up IS still announced as live" "[ $? -eq 0 ]"
check "and the live message is the real one" "grep -q 'faucet is live' '$T/healthy.log'"

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

# The version pin has to reach the stack, and until now nothing consumed it: only
# audit-drift read stack-versions.env, so a bump changed what the audit EXPECTED and
# nothing about what ran.
deploy_fresh_env
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.2.0\nZ3_ZAINO_IMAGE=zingodevops/zainod:1.0\n' \
  > "$D/z3/stack-versions.env"
FAUCET_MINER_ADDRESS="$GOOD_ADDR" run_deploy > "$T/pin.log" 2>&1
check "a deploy with pins exits 0" "[ $? -eq 0 ]"
check "the override carries the pinned zebra image" \
  "grep -q 'image: \"zfnd/zebra:6.2.0\"' '$D/z3-stack/docker-compose.override.yml'"
check "and the pinned zaino image" \
  "grep -q 'image: \"zingodevops/zainod:1.0\"' '$D/z3-stack/docker-compose.override.yml'"
# The bug this pins: a service named twice is not a merge, the later key wins and the
# earlier one is silently dropped. Emitting zebra once for the address and once for the
# image would have quietly unfunded the box.
check "zebra appears exactly ONCE, so the miner address is not dropped" \
  "[ \"\$(grep -c '^  zebra:\$' '$D/z3-stack/docker-compose.override.yml')\" = '1' ]"
check "and the miner address survived alongside the image" \
  "grep -q 'ZEBRA_MINING__MINER_ADDRESS: \"$GOOD_ADDR\"' '$D/z3-stack/docker-compose.override.yml'"
check "an unpinned component says so rather than guessing a tag" \
  "grep -q 'zallet has no pinned image' '$T/pin.log'"

# Images must land even with no miner address: a box that serves without mining still
# has to run the versions we reviewed.
deploy_fresh_env
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.2.3\n' > "$D/z3/stack-versions.env"
run_deploy > "$T/pin-nomine.log" 2>&1
check "pins are written with no miner address set" \
  "grep -q 'image: \"zfnd/zebra:6.2.3\"' '$D/z3-stack/docker-compose.override.yml'"
check "and no environment block is invented for a box that does not mine" \
  "! grep -q 'ZEBRA_MINING__MINER_ADDRESS' '$D/z3-stack/docker-compose.override.yml'"

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
# The refusal stands; its REASON has now been wrong twice and the test pins the
# survivor. Not "the protocol forbids it" (false since Heartwood), and not "we have
# not verified what zebra pays to" (false since #195 read
# TransactionTemplate::new_coinbase and found orchard-then-sapling-then-transparent).
# The honest reason is the WALLET side: zebra would pay shielded, and we have not
# verified our own wallet can see or spend such a coinbase.
check "and names the WALLET as the unverified side, not the protocol or zebra" \
  "grep -q 'OUR wallet detects and can spend a shielded coinbase' '$T/shielded.log'"
check "and credits zebra with doing the right thing" \
  "grep -q 'Zebra WOULD mine this shielded' '$T/shielded.log'"
check "and does not assert the first false rule" \
  "! grep -q 'only pay a TRANSPARENT address' '$T/shielded.log'"
check "and does not assert the second false rule" \
  "! grep -q 'have not verified that zebra builds' '$T/shielded.log'"
check "and does NOT blame base58" "! grep -q 'not base58' '$T/shielded.log'"

# t2 (P2SH) is the other valid testnet form and had no coverage at all, so a
# regression that accepted only tm would have passed the whole suite (#165).
deploy_fresh_env
FAUCET_MINER_ADDRESS="t2HifwjUj9uyxr9bknR8LFuQbc98c3vkXtu" run_deploy > "$T/t2.log" 2>&1
check "a valid t2 P2SH testnet address is accepted" "[ $? -eq 0 ]"
check "and the override carries it" \
  "grep -q 'ZEBRA_MINING__MINER_ADDRESS: \"t2HifwjUj9uyxr9bknR8LFuQbc98c3vkXtu\"' '$D/z3-stack/docker-compose.override.yml'"

# The version-byte check, and BOTH vectors below have VALID checksums. That is the
# point: they pass the prefix regex, the base58 alphabet, the length check and the
# checksum, so before this check they were accepted as testnet addresses. Verified
# reachable rather than assumed, by encoding one-off version bytes and observing
# what they render as: 0x1d26 renders as tm..., 0x1cbb renders as t2....
deploy_fresh_env
FAUCET_MINER_ADDRESS="tmt46wuJtJjoFuREQa5gP7pKBF2LtVJe8zi" run_deploy > "$T/badver-tm.log" 2>&1
check "a tm-looking address with the WRONG version byte is refused" "[ $? -ne 0 ]"
check "and it says version bytes, not checksum, because the checksum passed" \
  "grep -q 'version bytes' '$T/badver-tm.log'"
check "and it does NOT blame a typo, which would send the operator to re-paste a valid address" \
  "! grep -q 'it is a typo' '$T/badver-tm.log'"
check "and NO override is written" "[ ! -f '$D/z3-stack/docker-compose.override.yml' ]"

deploy_fresh_env
FAUCET_MINER_ADDRESS="t2ptZbHR4LSDWQ3K8xC3HEQBzu3mxTsMzBu" run_deploy > "$T/badver-t2.log" 2>&1
check "a t2-looking address with the WRONG version byte is refused too" "[ $? -ne 0 ]"

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
