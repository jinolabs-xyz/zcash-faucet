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

# An override we did NOT write is not ours to overwrite for an image pin. Main guarded
# this with `elif [ -f "$OVERRIDE" ]`, reached only when nothing else wrote the file, and
# NOTHING TESTED IT: giving pins a reason to write made the guard unreachable and only a
# missing log line noticed. stack-versions.env is committed, so that is every real box.
deploy_fresh_env
mkdir -p "$D/z3-stack"
printf 'services:\n  zebra:\n    environment:\n      ZEBRA_MINING__MINER_ADDRESS: "%s"\n' \
  "$GOOD_ADDR" > "$D/z3-stack/docker-compose.override.yml"
run_deploy > "$T/foreign.log" 2>&1
check "a hand-written override is left alone with no address set" \
  "grep -q 'ZEBRA_MINING__MINER_ADDRESS: \"$GOOD_ADDR\"' '$D/z3-stack/docker-compose.override.yml'"
check "and it is NOT replaced by a pin-only file" \
  "! grep -q 'GENERATED by deploy' '$D/z3-stack/docker-compose.override.yml'"
check "and the deploy says the pins were not applied, rather than implying they were" \
  "grep -q 'image pins were NOT applied' '$T/foreign.log'"
check "and names why it kept the file" "grep -q 'not generated by this script' '$T/foreign.log'"

# An override WE generated is a file we understand every key of, so the address in it
# survives a deploy that only knows about pins.
deploy_fresh_env
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.2.3\n' > "$D/z3/stack-versions.env"
FAUCET_MINER_ADDRESS="$GOOD_ADDR" run_deploy > "$T/gen1.log" 2>&1
run_deploy > "$T/gen2.log" 2>&1
check "a second deploy with the variable unset keeps the address it wrote before" \
  "grep -q 'ZEBRA_MINING__MINER_ADDRESS: \"$GOOD_ADDR\"' '$D/z3-stack/docker-compose.override.yml'"
check "and says it carried it, so the operator is not told mining is unchanged by luck" \
  "grep -q 'carrying the miner address' '$T/gen2.log'"
check "and still applies the pin" \
  "grep -q 'image: \"zfnd/zebra:6.2.3\"' '$D/z3-stack/docker-compose.override.yml'"

# A generated file that was hand-edited to a bad address is losing every block reward
# now. Refusing the deploy is the fail-closed direction on a money path.
#
# The mainnet vector, not an invented string: a made-up address fails the base58
# alphabet check and would prove only that the regex ran. This one has a valid
# checksum, so reaching WRONG NETWORK proves the whole validator ran on the CARRIED
# value rather than on the variable.
deploy_fresh_env
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.2.3\n' > "$D/z3/stack-versions.env"
FAUCET_MINER_ADDRESS="$GOOD_ADDR" run_deploy > /dev/null 2>&1
sed -i 's/ZEBRA_MINING__MINER_ADDRESS: .*/ZEBRA_MINING__MINER_ADDRESS: "t1UiVxo1bbZLP5z6KYfM4dh3PcX5wkd7on8"/' \
  "$D/z3-stack/docker-compose.override.yml"
run_deploy > "$T/carrybad.log" 2>&1
check "a carried address is validated, not trusted because we wrote the file" \
  "[ $? -ne 0 ]"
check "and the refusal names the real reason, so the validator ran on the carried value" \
  "grep -q 'WRONG NETWORK' '$T/carrybad.log'"

# An unset variable must not be an error: a box can serve without mining.
deploy_fresh_env
run_deploy > "$T/unset.log" 2>&1
check "an unset miner address is not an error" "[ $? -eq 0 ]"
check "but it says the faucet will not mine" "grep -q 'will not mine' '$T/unset.log'"

# ── zallet RPC auth (#176) ───────────────────────────────────────────────────────
# At the END of the file on purpose. These cases each call deploy_fresh_env, and I first
# inserted them mid-file, ahead of "re-run on the same box is a clean no-op pass". That
# test reads the state the FIRST fixture built, so resetting the environment in front of
# it left it re-running against a fresh box: it stopped testing a re-run at all, and the
# suite stalled instead of failing, which is the more expensive way to find out.

echo "== zallet RPC auth: the config gets a HASH, and it matches the faucet's password"
# #176: the config held the password in plaintext, and a diagnostic grep for the wallet
# database path printed it into tooling output, a transcript and an IPC archive.
ZCFG_T="$D/z3-stack/config/testnet/zallet.toml"
check "the config has a pwhash" "grep -q '^pwhash = ' '$ZCFG_T'"
check "and NO plaintext password line at all" "! grep -qE '^[[:space:]]*password[[:space:]]*=' '$ZCFG_T'"
check "and the faucet still got a password to authenticate with" \
  "grep -qE '^ZALLET_RPC_PASSWORD=..*' '$D/z3/faucet.env'"
# The assertion that would catch a silent break. A hash the password does not verify
# against means every drip fails with an auth error, and nothing else here would notice:
# both files are present, both look right, and they do not correspond.
check "the pwhash VERIFIES against the password in faucet.env" \
  "python3 '$SCRATCH/verify-pwhash.py' '$ZCFG_T' '$D/z3/faucet.env'"

echo "== zallet RPC auth: a re-run does not rotate a credential that is already hashed"
# Rotating on every deploy would invalidate the running faucet's password twice per
# deploy and produce auth failures that look like a wallet fault.
# No PWHASH_BEFORE here on purpose. It used to be captured for a hash-stability assertion
# that was correctly abandoned - see the comment below - and the leftover capture read as a
# comparison this block makes and does not.
PW_BEFORE="$(grep '^ZALLET_RPC_PASSWORD=' "$D/z3/faucet.env")"
run_deploy > "$T/auth-rerun.log" 2>&1
check "a re-run keeps the same password" \
  "[ \"\$(grep '^ZALLET_RPC_PASSWORD=' '$D/z3/faucet.env')\" = \"$PW_BEFORE\" ]"
check "and does not announce a rotation" "! grep -q 'Rotating the Zallet RPC password' '$T/auth-rerun.log'"
# The hash itself is allowed to change: the salt is fresh each write, and the same
# password under a new salt is still the same credential. Asserting the hash is stable
# would pin an implementation detail and forbid a correct implementation.
check "and the re-run's hash still verifies, whether or not the salt moved" \
  "python3 '$SCRATCH/verify-pwhash.py' '$ZCFG_T' '$D/z3/faucet.env'"

echo "== zallet RPC auth: a plaintext password on the box is ROTATED, not just hidden"
# Hashing the value that leaked would hide it and leave it valid. The exposed
# credential has to STOP WORKING, which is the actual ask in #176.
deploy_fresh_env
printf '[[rpc.auth]]\nuser = "faucet"\npassword = "THE-LEAKED-VALUE"\n' \
  > "$D/z3-stack/config/testnet/zallet.toml"
run_deploy > "$T/auth-rotate.log" 2>&1
check "the deploy says it is rotating, and why" \
  "grep -q 'Rotating the Zallet RPC password' '$T/auth-rotate.log'"
check "the leaked plaintext is GONE from the config" \
  "! grep -q 'THE-LEAKED-VALUE' '$D/z3-stack/config/testnet/zallet.toml'"
check "and the faucet is NOT still using the leaked value" \
  "! grep -q 'THE-LEAKED-VALUE' '$D/z3/faucet.env'"
check "the config carries a hash instead" \
  "grep -q '^pwhash = ' '$D/z3-stack/config/testnet/zallet.toml'"

echo "== zallet RPC auth: rewriting the config is not the wallet changing its mind"
# The bug the CTO found by running #275 on the box and checking BOTH directions:
#   old password -> 200 (still working)   new password -> 401 (rejected)
# Backwards, because `up -d` compares the container SPEC and a rewritten bind-mounted
# file leaves it identical, so compose did nothing and zallet served the config it had
# read into memory hours before. The faucet went blind AND the leaked value stayed live.
deploy_fresh_env
printf '[[rpc.auth]]\nuser = "faucet"\npassword = "THE-LEAKED-VALUE"\n' \
  > "$D/z3-stack/config/testnet/zallet.toml"
: > "$STUB_LOG"
run_deploy > "$T/auth-restart.log" 2>&1
check "a rotating deploy exits 0 once the wallet really has the new credential" "[ $? -eq 0 ]"
check "it asks for an EXPLICIT restart, not just up -d" \
  "grep -q 'restart z3-testnet-zallet-1' '$STUB_LOG'"
check "and the restart comes AFTER the config was rewritten, not before" \
  "[ \"\$(grep -n 'zallet-loaded-config' '$STUB_LOG' | tail -1 | cut -d: -f1)\" -ge \"\$(grep -n 'restart z3-testnet-zallet-1' '$STUB_LOG' | head -1 | cut -d: -f1)\" ]"
check "it says the new credential authenticates" \
  "grep -q 'the new credential authenticates' '$T/auth-restart.log'"
check "and that the previous one is now rejected, which is what closes #176" \
  "grep -q 'previous credential is now rejected' '$T/auth-restart.log'"

echo "== zallet RPC auth: a wallet that IGNORES the restart must fail the deploy"
# The production state itself, as a test. Without this the only evidence the refusal
# works is that a human once watched it work by hand.
deploy_fresh_env
printf '[[rpc.auth]]\nuser = "faucet"\npassword = "THE-LEAKED-VALUE"\n' \
  > "$D/z3-stack/config/testnet/zallet.toml"
# The box as it was FOUND, which my first version of this fixture got wrong: zallet
# ALREADY RUNNING since before the deploy, with the old plaintext already in memory.
# Starting from nothing meant the container was created after the rewrite and so came up
# holding the NEW credential, and the test then passed for the wrong reason.
printf 'running\nz3-testnet\n' > "$STUB_CONTAINERS/z3-testnet-zallet-1"
printf 'THE-LEAKED-VALUE' > "$STUB_ZALLET_LOADED"
STUB_ZALLET_IGNORE_RESTART=1 run_deploy > "$T/auth-stale.log" 2>&1
check "a deploy whose wallet never reloaded REFUSES rather than reporting success" \
  "[ $? -ne 0 ]"
# It refuses on the NEW credential first, which is the right order: that is the check
# that fires. But the message has to lead with the security fact, because a blind faucet
# is visible in minutes and a live leaked credential is not visible at all.
check "and names the real problem: the exposed value is still live" \
  "grep -q 'PREVIOUS CREDENTIAL STILL AUTHENTICATES' '$T/auth-stale.log'"
check "and says the rotation did not take effect" \
  "grep -q 'rotation did not take effect' '$T/auth-stale.log'"
check "it does NOT print a success line, which is the false pass this replaces" \
  "! grep -q 'previous credential is now rejected' '$T/auth-stale.log'"

echo "== zallet RPC auth: an unreachable wallet is UNVERIFIED, not rotated"
# Three states, not two. A wallet we cannot reach has told us nothing, and reporting a
# rotation on silence is the same error in a quieter voice.
deploy_fresh_env
printf '[[rpc.auth]]\nuser = "faucet"\npassword = "THE-LEAKED-VALUE"\n' \
  > "$D/z3-stack/config/testnet/zallet.toml"
STUB_ZALLET_LOADED="" run_deploy > "$T/auth-unreach.log" 2>&1
check "an unreachable wallet fails the deploy" "[ $? -ne 0 ]"
check "and is reported as UNVERIFIED rather than as either answer" \
  "grep -q 'UNVERIFIED' '$T/auth-unreach.log'"

echo "== zallet RPC auth: another operator's entry is not ours to rotate or to break"
# My first version grepped the WHOLE file for a plaintext password, so a second
# operator's block would have rotated our credential and then refused the deploy over
# a line we have no business changing.
deploy_fresh_env
printf '[[rpc.auth]]\nuser = "someone-else"\npassword = "THEIR-SECRET"\n' \
  > "$D/z3-stack/config/testnet/zallet.toml"
run_deploy > "$T/auth-other.log" 2>&1
check "a deploy beside another operator's plaintext entry still succeeds" "[ $? -eq 0 ]"
check "their entry is untouched" \
  "grep -q 'THEIR-SECRET' '$D/z3-stack/config/testnet/zallet.toml'"
check "and their line did not trigger a rotation of ours" \
  "! grep -q 'Rotating the Zallet RPC password' '$T/auth-other.log'"
check "ours is added as a hash alongside theirs" \
  "grep -q '^pwhash = ' '$D/z3-stack/config/testnet/zallet.toml'"

# ── the three defects a real deploy on the box produced ──────────────────────────
# All three share one shape: the script asserted nothing about the state it left behind.

echo "== domain: an unset FAUCET_DOMAIN does not mean plain HTTP on a box that has one"
# Running without the variable took the Caddyfile's ':80' default, Caddy stopped binding
# 443, and HSTS with a one-year max-age meant browsers refused to fall back to HTTP. A
# total outage to real users while every container read healthy.
deploy_fresh_env
printf 'faucet.example.org\n' > "$T/faucet-domain"
FAUCET_DOMAIN_FILE="$T/faucet-domain" run_deploy > "$T/dom-file.log" 2>&1
check "the domain is taken from the box's own record" \
  "grep -q 'Serving https://faucet.example.org' '$T/dom-file.log'"
check "and the deploy does not announce a plain-HTTP fallback" \
  "! grep -q 'serves plain HTTP' '$T/dom-file.log'"

echo "== domain: REFUSE to downgrade a box that is already serving HTTPS"
# The second signal, for a box with a domain but no record of one. Asked of the running
# proxy, because that is the only place the truth lives on such a box.
deploy_fresh_env
printf 'running\nzcash-faucet\n' > "$STUB_CONTAINERS/zcash-faucet-caddy-1"
export STUB_ENV_zcash_faucet_caddy_1="FAUCET_DOMAIN=live.example.org"
FAUCET_DOMAIN_FILE="$T/no-such-domain-file" run_deploy > "$T/dom-refuse.log" 2>&1
check "a deploy that would drop HTTPS is REFUSED" "[ $? -ne 0 ]"
check "and it names the domain that would have been lost" \
  "grep -q 'already serving HTTPS for live.example.org' '$T/dom-refuse.log'"
check "and explains HSTS, so nobody reads it as a soft failure" \
  "grep -q 'HSTS' '$T/dom-refuse.log'"
check "and gives the exact command to fix it" \
  "grep -q 'FAUCET_DOMAIN=live.example.org' '$T/dom-refuse.log'"
unset STUB_ENV_zcash_faucet_caddy_1

echo "== domain: a box that never had one still gets its :80 smoke test"
# The refusal must not break the legitimate case, or the next person deletes it.
deploy_fresh_env
FAUCET_DOMAIN_FILE="$T/no-such-domain-file" run_deploy > "$T/dom-none.log" 2>&1
check "no domain anywhere is not an error" "[ $? -eq 0 ]"
check "and it says plainly that this serves plain HTTP" \
  "grep -q 'serves plain HTTP' '$T/dom-none.log'"

echo "== account: an account already in use is NEVER replaced by a generated one"
# This took the visible balance from 758.46 TAZ to 0. The funds never moved; the faucet
# was repointed at a fresh empty account and could no longer see them. The old guard
# checked a sidecar file inside the checkout, which a replaced checkout does not have.
deploy_fresh_env
cp "$D/z3/faucet.env.example" "$D/z3/faucet.env"
python3 - "$D/z3/faucet.env" <<'PYEOF'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = re.sub(r'(?m)^ZALLET_ACCOUNT=.*$', 'ZALLET_ACCOUNT=funded-account-9ae4d3a3', s)
s = re.sub(r'(?m)^ZALLET_ADDRESS=.*$', 'ZALLET_ADDRESS=utest1thefundedone', s)
open(p, 'w').write(s)
PYEOF
rm -f "$D/.faucet-account"
: > "$STUB_LOG"
run_deploy > "$T/acct.log" 2>&1
check "a deploy beside a configured account exits 0" "[ $? -eq 0 ]"
check "NO new account is created" "[ \"\$(grep -c 'z_getnewaccount' '$STUB_LOG')\" = '0' ]"
check "the funded account survives in faucet.env" \
  "grep -q '^ZALLET_ACCOUNT=funded-account-9ae4d3a3\$' '$D/z3/faucet.env'"
check "and its address survives too" \
  "grep -q '^ZALLET_ADDRESS=utest1thefundedone\$' '$D/z3/faucet.env'"
check "and the deploy says it reused rather than created" \
  "grep -q 'Reusing the account already configured' '$T/acct.log'"
check "and the post-condition confirms the account is unchanged" \
  "grep -q 'wallet account is unchanged' '$T/acct.log'"

echo "== post-conditions: an outage invisible from inside the box still fails the deploy"
# Containers healthy, /api/health 200 on localhost, 443 unbound. Only a request to the
# public name can see it, so that is what the post-condition asks.
deploy_fresh_env
printf 'faucet.example.org\n' > "$T/faucet-domain"
FAUCET_DOMAIN_FILE="$T/faucet-domain" STUB_HTTPS_CODE=000 run_deploy > "$T/post-https.log" 2>&1
check "a site that does not answer over HTTPS FAILS the deploy" "[ $? -ne 0 ]"
check "and it is reported as a post-condition, not as a step that errored" \
  "grep -q 'POST-CONDITION FAILED' '$T/post-https.log'"
check "and it says why HSTS makes this an outage rather than a degradation" \
  "grep -q 'will not fall back to HTTP' '$T/post-https.log'"
check "and the deploy does NOT claim the faucet is live" \
  "! grep -q 'The faucet is live' '$T/post-https.log'"

echo "== post-conditions: a wallet that accepts ANY password fails the deploy"
# The negative control on the auth probe itself. A probe that only ever sees 200 cannot
# tell authentication from a server saying yes to everything, so the post-condition sends
# a deliberately wrong password. This proves that assertion can actually fail.
deploy_fresh_env
STUB_ZALLET_ACCEPT_ANY=1 run_deploy > "$T/post-anypw.log" 2>&1
check "a wallet accepting a wrong password FAILS the deploy" "[ $? -ne 0 ]"
check "and says the probe proves nothing about authentication" \
  "grep -q 'accepted a WRONG password' '$T/post-anypw.log'"
