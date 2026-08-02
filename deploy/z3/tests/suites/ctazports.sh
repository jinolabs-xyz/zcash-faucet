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
  #
  # SEEDED WITH sshd AND https, not left empty. An empty listing now means "the tool cannot
  # see" rather than "quiet host", so an empty default would make every test here run in
  # cannot-verify and quietly stop testing what it claims to. The faithful double is a box
  # you could actually have reached. Neither port collides with any base used below.
  printf '0.0.0.0:22\n0.0.0.0:443\n' > "$T/listeners"
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

echo "== ctaz-port-check: LOSING ONE SOURCE ENTIRELY is cannot-verify, even though the other is healthy"
# THE PREMISE OF THIS TEST WAS WRONG AND SDE-App CAUGHT IT (#332). The old fixture emptied
# both files, totalling ONE port, which is under any threshold -- so it verified the
# threshold and not the property. The property is that EACH source must have returned
# something.
#
# The fixture below is the dangerous shape: audit-access is fully intact and yields FIVE
# ports, comfortably past any combined threshold, while the loopback block is gone. App
# demonstrated the consequence against real sockets: with the block renamed the script
# reported ALL FOUR SLOTS FREE for a base whose P+10000 is 18137 -- our own zaino gRPC.
pc_env
printf '#!/usr/bin/env bash\n# the loopback block has been renamed or removed\nZ3_OTHER=(\n)\n' \
  > "$T/deploy/deploy.sh"
bash "$PC" 8137 > "$T/partial.log" 2>&1
check "losing the loopback block alone exits 2, despite five ports from the other file" \
  "[ $? -eq 2 ]"
check "and it names WHICH source came back empty" \
  "grep -q 'the loopback-bindings block' '$T/partial.log'"
check "and reports each source's count separately, not a total" \
  "grep -qE 'Read 0 from deploy.sh and [1-9][0-9]* from audit-access.sh' '$T/partial.log'"
check "and above all does NOT report 18137 free, which we already hold" \
  "! grep -q 'all four slots are free' '$T/partial.log'"

echo "== ctaz-port-check: losing the OTHER source is caught too"
# Both directions, so the per-source check cannot be half-implemented and still pass.
pc_env
printf '#!/usr/bin/env bash\n' > "$T/deploy/z3/audit-access.sh"
bash "$PC" 19233 > "$T/partial2.log" 2>&1
check "losing ACCESS_PUBLIC_PORTS exits 2, despite a healthy loopback block" "[ $? -eq 2 ]"
check "and names that source" "grep -q 'ACCESS_PUBLIC_PORTS' '$T/partial2.log'"

echo "== ctaz-port-check: a listener tool that FAILED is not the same as one that is ABSENT"
# SDE-App's (#332), with the rationale CORRECTED. I first wrote that the old code took
# awk's status through the pipe so a failing lsof read as free. That was wrong: `set -uo
# pipefail` predates all of this and App proved the old code already exited 2 here. The
# split between absent and failed is still worth keeping, because a missing package and a
# tool denied by permissions are different things to tell an operator, but this case was
# never the hole. The hole is the empty-but-successful one below.
pc_env
printf '#!/usr/bin/env bash\nexit 9\n' > "$T/failing-listen"; chmod +x "$T/failing-listen"
CTAZ_LISTEN_CMD="$T/failing-listen" bash "$PC" 19233 > "$T/failed.log" 2>&1
check "a FAILING listener tool exits 2" "[ $? -eq 2 ]"
check "and says it failed rather than that it is missing" \
  "grep -q 'exists but FAILED' '$T/failed.log'"
check "and does not report an UNQUALIFIED all-clear" \
  "! grep -q '^.*all four slots are free$' '$T/failed.log'"
# The qualified line is the correct output here and is worth pinning, so a future edit
# cannot quietly drop the caveat and leave the bare claim behind.
check "and the free-claim it does print is qualified as repo-declared only" \
  "grep -q 'free of REPO-DECLARED ports, but live listeners were not checked' '$T/failed.log'"

echo "== ctaz-port-check: EMPTY BUT SUCCESSFUL is cannot-verify, not a quiet machine"
# I argued the other way and the CTO overruled me on App's reasoning, which is better than
# mine: on any box this runs against you arrived over sshd, so zero listening sockets is
# not a plausible silent host, it is a tool that cannot see. lsof warns to stderr and
# 2>/dev/null eats it, so blind-but-exit-zero is the realistic permissions shape.
#
# The asymmetry decides it. Cannot-verify on a genuinely silent host costs one double
# check. Free while the tool is blind recommends taking a port we already hold.
pc_env
: > "$T/listeners"
bash "$PC" 19233 > "$T/quiet.log" 2>&1
check "an empty-but-successful listing exits exactly 2" "[ $? -eq 2 ]"
check "and says why, naming sshd as what should have been visible" \
  "grep -q 'sshd alone should have been visible' '$T/quiet.log'"
check "and does not give an unqualified all-clear" \
  "! grep -q '^.*all four slots are free$' '$T/quiet.log'"

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

echo "== ctaz-port-check: bad input exits 2, NOT 1, because 1 means a real collision"
# Also App's (#332). die() exited 1, which the header reserves for "a slot collides". A
# caller honouring that contract reads an out-of-range argument as a collision and goes
# looking for another port -- forever. Usage errors are cannot-verify, not known-bad.
pc_env
bash "$PC" 80 > "$T/low.log" 2>&1
check "a privileged base exits exactly 2" "[ $? -eq 2 ]"
check "and says why" "grep -q 'must be above 1024' '$T/low.log'"
pc_env
bash "$PC" 60000 > "$T/high.log" 2>&1
check "a base whose P+10001 would overflow exits exactly 2" "[ $? -eq 2 ]"
check "and says why" "grep -q 'must be below 55535' '$T/high.log'"
pc_env
bash "$PC" not-a-port > "$T/nan.log" 2>&1
check "a non-numeric base exits 2" "[ $? -eq 2 ]"
pc_env
bash "$PC" > "$T/noarg.log" 2>&1
check "no argument at all exits 2 and prints usage" \
  "[ $? -eq 2 ] && grep -q 'usage:' '$T/noarg.log'"

# ── ctaz-datadir-guard.sh ────────────────────────────────────────────────────────
# Refuses to START a cTAZ node whose state already exceeds what the box can spare.
# Not a quota, and the tests say so: nothing here stops a running node growing.

GUARD="$REPO/deploy/z3/ctaz-datadir-guard.sh"

guard_env() { mk_scratch "${TMPDIR:-/tmp}/ctazguard.XXXXXX"; mkdir -p "$T/data"; }

echo "== ctaz-datadir-guard: a datadir under the ceiling starts"
guard_env
dd if=/dev/zero of="$T/data/blob" bs=1024 count=2048 2>/dev/null   # 2 MB
bash "$GUARD" "$T/data" 1 > "$T/ok.log" 2>&1
check "under the ceiling exits 0" "[ $? -eq 0 ]"
check "and reports what it measured against what it allows" \
  "grep -qE 'holds [0-9.]+ GB of a 1 GB ceiling' '$T/ok.log'"

echo "== ctaz-datadir-guard: a datadir OVER the ceiling refuses to start"
# The assertion that matters. A guard that never fires is decoration.
guard_env
dd if=/dev/zero of="$T/data/blob" bs=1048576 count=12 2>/dev/null  # 12 MB
CEIL_KB=1 bash -c "true"
# ceiling of 0 is rejected, so express the small ceiling by making the dir big instead:
dd if=/dev/zero of="$T/data/blob2" bs=1048576 count=1100 2>/dev/null  # ~1.1 GB total
bash "$GUARD" "$T/data" 1 > "$T/over.log" 2>&1
check "over the ceiling exits exactly 1" "[ $? -eq 1 ]"
check "and says it is refusing to start" "grep -q 'REFUSING TO START' '$T/over.log'"
check "and names both the size and the ceiling" \
  "grep -qE 'holds [0-9.]+ GB, ceiling is 1 GB' '$T/over.log'"
check "and tells the operator what their options are" \
  "grep -q 'CTAZ_MAX_STATE_GB' '$T/over.log'"

echo "== ctaz-datadir-guard: a datadir that does not exist yet is fine, not a fault"
guard_env
bash "$GUARD" "$T/not-created-yet" 10 > "$T/absent.log" 2>&1
check "first boot exits 0" "[ $? -eq 0 ]"
check "and says why rather than being silent" "grep -q 'nothing to check' '$T/absent.log'"

echo "== ctaz-datadir-guard: an unmeasurable datadir is CANNOT-VERIFY, never a pass"
# The whole point is to remove the assumption that unmeasured means small.
guard_env
mkdir -p "$T/stub"
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/stub/du"; chmod +x "$T/stub/du"
PATH="$T/stub:$PATH" bash "$GUARD" "$T/data" 10 > "$T/nodu.log" 2>&1
check "an unmeasurable datadir exits exactly 2" "[ $? -eq 2 ]"
check "and refuses to assume it is small" \
  "grep -q 'exactly what' '$T/nodu.log'"
check "and does not report ok" "! grep -q '^.*ok: ' '$T/nodu.log'"

echo "== ctaz-datadir-guard: bad arguments are refused rather than guessed at"
guard_env
bash "$GUARD" "$T/data" not-a-number > "$T/nan.log" 2>&1
check "a non-numeric ceiling exits 2" "[ $? -eq 2 ]"
guard_env
bash "$GUARD" "$T/data" 0 > "$T/zero.log" 2>&1
check "a zero ceiling exits 2 rather than refusing everything" "[ $? -eq 2 ]"
guard_env
bash "$GUARD" > "$T/noargs.log" 2>&1
check "no arguments exits 2 with usage" "[ $? -eq 2 ] && grep -q 'usage:' '$T/noargs.log'"
