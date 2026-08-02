# shellcheck shell=bash
# ctaz-port-check.sh: choosing a base port for the crosslink node is choosing FOUR ports.
#
# The case that motivates the whole script is the 18233 one: their default base 8233 puts
# zaino's JSON-RPC on 8233+10000, which is our zebra P2P port. The obvious worry (their RPC
# on 8232) is a non-issue on a testnet box. So the tests below are written to fail if the
# script ever stops catching the non-obvious slot, which is the only slot that matters.

PC="$REPO/deploy/z3/ctaz-port-check.sh"

pc_env() {
  mk_scratch "${TMPDIR:-/tmp}/ctazports.XXXXXX"
  mkdir -p "$T/deploy/z3"
  # A faithful copy of how the repo really declares ports: the loopback block spans both
  # networks, and the public list is a separate line in a different file.
  cat > "$T/deploy/deploy.sh" <<'DEP'
#!/usr/bin/env bash
Z3_LOOPBACK_BINDINGS=(
  "Z3_ZEBRA_HOST_RPC_PORT=127.0.0.1:$([ "$NETWORK" = testnet ] && echo 18232 || echo 8232)"
  "Z3_ZEBRA_HOST_HEALTH_PORT=127.0.0.1:$([ "$NETWORK" = testnet ] && echo 18080 || echo 8080)"
  "Z3_ZALLET_HOST_RPC_PORT=127.0.0.1:$([ "$NETWORK" = testnet ] && echo 40232 || echo 28232)"
  "Z3_ZAINO_HOST_GRPC_PORT=127.0.0.1:$([ "$NETWORK" = testnet ] && echo 18137 || echo 8137)"
  "Z3_ZAINO_HOST_JSON_RPC_PORT=127.0.0.1:$([ "$NETWORK" = testnet ] && echo 18237 || echo 8237)"
)
DEP
  cat > "$T/deploy/z3/audit-access.sh" <<'ACC'
#!/usr/bin/env bash
ACCESS_PUBLIC_PORTS="${ACCESS_PUBLIC_PORTS:-22 80 443 18233 8233}"
ACC
  export CTAZ_DEPLOY_SH="$T/deploy/deploy.sh"
  export CTAZ_ACCESS_SH="$T/deploy/z3/audit-access.sh"
  # A listener double, so "what is live" is something a test can state rather than inherit
  # from whatever happens to be running on the machine executing the suite.
  printf '' > "$T/listeners"
  cat > "$T/fake-listen" <<'FL'
#!/usr/bin/env bash
cat "$FAKE_LISTEN_FILE"
FL
  chmod +x "$T/fake-listen"
  export FAKE_LISTEN_FILE="$T/listeners"
  export CTAZ_LISTEN_CMD="$T/fake-listen"
}

echo "== ctaz-port-check: THE 18233 CASE. their default base 8233 must be refused"
# zaino json = 8233+10000 = 18233 = our zebra P2P. This is the entire reason the script
# exists; if this ever goes green the script has stopped being worth running.
pc_env
bash "$PC" 8233 > "$T/default.log" 2>&1
check "their default base 8233 is REFUSED" "[ $? -eq 1 ]"
check "and the collision named is 18233, not 8232" \
  "grep -q 'COLLISION  18233' '$T/default.log'"
check "and it is attributed to our zebra P2P" \
  "grep -q 'our zebra P2P' '$T/default.log'"
check "and it names the slot as the zaino one, so the +10000 is visible" \
  "grep -qE 'COLLISION  18233.*zaino JSON-RPC \(P\+10000\)' '$T/default.log'"

echo "== ctaz-port-check: the 8232 collision people EXPECT is not reported on a testnet box"
# Being right for the right reason: 8232 is declared (mainnet zebra RPC) so it IS a
# conflict, but it must be reported as the P-1 slot, not confused with the 18233 finding.
pc_env
bash "$PC" 8233 > "$T/expect.log" 2>&1
check "8232 is flagged as the P-1 slot" \
  "grep -qE 'COLLISION  8232.*zebrad JSON-RPC \(P-1\)' '$T/expect.log'"

echo "== ctaz-port-check: a genuinely clear base passes"
pc_env
bash "$PC" 19233 > "$T/clear.log" 2>&1
check "a clear base exits 0" "[ $? -eq 0 ]"
check "and says all four are free" "grep -q 'all four slots are free' '$T/clear.log'"
check "and it really checked four" \
  "[ \$(grep -c '  free  ' '$T/clear.log') -eq 4 ]"

echo "== ctaz-port-check: a live listener on ANY of the four slots is caught"
# The repo can say a port is free while something holds it. Only one of those stops a bind.
pc_env
printf '127.0.0.1:29234\n' > "$T/listeners"
bash "$PC" 19234 > "$T/live.log" 2>&1
check "a live listener on P+10000 is caught" "[ $? -eq 1 ]"
check "and is reported as listening now, not as declared" \
  "grep -q 'listening on it right now' '$T/live.log'"

echo "== ctaz-port-check: a live listener on the gRPC slot is caught too"
pc_env
printf '*:29235\n' > "$T/listeners"
bash "$PC" 19234 > "$T/live2.log" 2>&1
check "a live listener on P+10001 is caught" "[ $? -eq 1 ]"
check "and the 0.0.0.0 bind is called out in the slot description" \
  "grep -q 'binds 0.0.0.0 as shipped' '$T/live2.log'"

echo "== ctaz-port-check: unreadable declarations are CANNOT-VERIFY, never a pass"
# The bug this is modelled on is mine: a grep run against the wrong directory matched zero
# files, and I read the empty result as 'no conflicts'. Empty must never mean clear.
pc_env
CTAZ_DEPLOY_SH="$T/nope.sh" CTAZ_ACCESS_SH="$T/also-nope.sh" bash "$PC" 19233 > "$T/blind.log" 2>&1
check "unreadable declarations exit exactly 2" "[ $? -eq 2 ]"
check "and it says it cannot verify" "grep -q 'CANNOT VERIFY' '$T/blind.log'"
check "and refuses to call that a result" \
  "grep -q 'a guess wearing a result' '$T/blind.log'"
check "and does NOT claim anything is free" "! grep -q 'all four slots are free' '$T/blind.log'"

echo "== ctaz-port-check: a PARTIAL declaration read is also cannot-verify"
# Half a list is the dangerous case: enough to look like it worked, not enough to be right.
pc_env
printf 'ACCESS_PUBLIC_PORTS="${ACCESS_PUBLIC_PORTS:-22}"\n' > "$T/deploy/z3/audit-access.sh"
printf '#!/usr/bin/env bash\n' > "$T/deploy/deploy.sh"
bash "$PC" 19233 > "$T/partial.log" 2>&1
check "a partial read exits 2" "[ $? -eq 2 ]"
check "and reports how many it actually read" \
  "grep -qE 'read only [0-9]+ declared port' '$T/partial.log'"

echo "== ctaz-port-check: no lsof and no ss is cannot-verify, not a pass"
pc_env
CTAZ_LISTEN_CMD="$T/no-such-tool" bash "$PC" 19233 > "$T/nolsof.log" 2>&1
check "a host that cannot list listeners exits 2" "[ $? -eq 2 ]"
check "and says the live half did not run" \
  "grep -q 'live listeners were not checked' '$T/nolsof.log'"
check "and does not claim all four are free" \
  "! grep -q '^.*all four slots are free$' '$T/nolsof.log'"

echo "== ctaz-port-check: --suggest returns a base whose whole family is clear"
pc_env
bash "$PC" --suggest > "$T/suggest.log" 2>&1
check "--suggest exits 0" "[ $? -eq 0 ]"
check "and prints all four derived ports, not just the base" \
  "grep -qE 'rpc [0-9]+, p2p [0-9]+, zaino json [0-9]+, zaino grpc [0-9]+' '$T/suggest.log'"
sug=$(sed -n 's/.*suggested base P2P port: \([0-9]*\).*/\1/p' "$T/suggest.log" | head -1)
check "and the base it suggested actually passes its own check" \
  "bash '$PC' '$sug' >/dev/null 2>&1"

echo "== ctaz-port-check: bad input is refused rather than guessed at"
pc_env
bash "$PC" 80 > "$T/low.log" 2>&1
check "a privileged base is refused" "[ $? -ne 0 ]"
check "and says why" "grep -q 'must be above 1024' '$T/low.log'"
pc_env
bash "$PC" 60000 > "$T/high.log" 2>&1
check "a base whose P+10001 would overflow the range is refused" "[ $? -ne 0 ]"
check "and says why" "grep -q 'must be below 55535' '$T/high.log'"
pc_env
bash "$PC" not-a-port > "$T/nan.log" 2>&1
check "a non-numeric base exits 2" "[ $? -eq 2 ]"
pc_env
bash "$PC" > "$T/noarg.log" 2>&1
check "no argument at all exits 2 and prints usage" \
  "[ $? -eq 2 ] && grep -q 'usage:' '$T/noarg.log'"
