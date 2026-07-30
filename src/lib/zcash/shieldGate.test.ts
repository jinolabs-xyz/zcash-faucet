import { test } from "node:test";
import assert from "node:assert/strict";
// chainFreshness alongside the shieldFreshness alias the older cases use: the
// module says new call sites should prefer the general name, and the #211 cases
// below are about any transaction build rather than a shield specifically.
import { shieldFreshness, chainFreshness, mayShield, SHIELD_MAX_LAG_BLOCKS } from "./shieldGate.ts";

// The decision is a pure function of two heights, so every branch — including the
// ones that only occur when a public endpoint is down — is reachable without
// mocking a module or touching a network. A test whose verdict depends on the
// public internet is not testing our code, which is exactly what made #171 red in
// CI while passing locally.

test("level with the network is safe", () => {
  const g = shieldFreshness(4_220_000, 4_220_000);
  assert.equal(g.state, "safe");
  assert.equal(g.lag, 0);
  assert.equal(mayShield(g), true);
});

test("a few blocks behind is still safe, because normal lag is not a fault", () => {
  assert.equal(shieldFreshness(4_220_000, 4_220_005).state, "safe");
});

test("our node reading AHEAD of the aggregate is safe, not suspicious", () => {
  // The oracle polls a dashboard whose own view is seconds stale, so being a few
  // blocks ahead is the normal case and must not read as a fault.
  const g = shieldFreshness(4_220_003, 4_220_000);
  assert.equal(g.state, "safe");
  assert.equal(g.lag, -3);
});

test("past the lag budget is unsafe", () => {
  const g = shieldFreshness(4_220_000 - (SHIELD_MAX_LAG_BLOCKS + 1), 4_220_000);
  assert.equal(g.state, "unsafe");
  assert.equal(mayShield(g), false);
  assert.match(g.reason, /blocks behind the network/);
});

test("THE #172 CASE: a 40-block lag is caught, where the 200-block freeze flag was not", () => {
  // tx 29 was built with the node 40+ blocks behind. FAUCET_FREEZE_BLOCKS=200
  // reported healthy throughout, correctly by its own definition, and the
  // transaction was born expired because Zcash sets expiry at tip+40.
  const g = shieldFreshness(4_217_941, 4_217_981);
  assert.equal(g.lag, 40);
  assert.equal(g.state, "unsafe");
  assert.equal(mayShield(g), false);
});

test("NO EXTERNAL TIP FAILS CLOSED — the whole point of the module", () => {
  const g = shieldFreshness(4_220_000, null);
  assert.equal(g.state, "unverifiable");
  assert.equal(mayShield(g), false);
  // Readiness deliberately fails OPEN on this same input. If someone ever copies
  // that shape here, this assertion is what stops it reaching production.
  assert.notEqual(g.state, "safe");
});

test("an unknown node height also fails closed", () => {
  const g = shieldFreshness(null, 4_220_000);
  assert.equal(g.state, "unverifiable");
  assert.equal(mayShield(g), false);
});

test("unverifiable is never let through by a not-unsafe test", () => {
  // Guards the specific mistake the API shape exists to prevent: a caller writing
  // `state !== "unsafe"` would broadcast on an unverified tip.
  const g = shieldFreshness(4_220_000, null);
  assert.equal(g.state !== "unsafe", true, "unverifiable is indeed not 'unsafe'");
  assert.equal(mayShield(g), false, "...but mayShield must still refuse it");
});

test("the lag budget leaves real headroom under the 40-block expiry cliff", () => {
  // 40 is where a transaction is GUARANTEED dead, not where safety ends. If this
  // ever fails, someone has raised the budget toward the cliff and the gate has
  // stopped being a margin.
  assert.ok(
    SHIELD_MAX_LAG_BLOCKS <= 10,
    `shield lag budget ${SHIELD_MAX_LAG_BLOCKS} is too close to Zcash's 40-block expiry delta`,
  );
});

test("every state carries a reason, including safe", () => {
  const cases: Array<[number | null, number | null]> = [
    [4_220_000, 4_220_000],
    [4_219_000, 4_220_000],
    [4_220_000, null],
    [null, 4_220_000],
  ];
  for (const [node, tip] of cases) {
    const g = shieldFreshness(node, tip);
    assert.ok(g.reason.length > 0, `state ${g.state} has an empty reason`);
  }
});

/* ------------------------------------------------- AHEAD is not WITHIN (#211) */

test("a node AHEAD does not claim to be 'within' the threshold", () => {
  // The exact reading off the live endpoint during the recovery pre-flight. The
  // verdict was right and the sentence was false, and a human read it while
  // deciding whether to move money.
  const gate = chainFreshness(4_221_872, 4_221_781);
  assert.equal(gate.state, "safe", "being ahead is safe, that part was never wrong");
  assert.equal(gate.lag, -91);
  assert.doesNotMatch(gate.reason, /within/, `still claims "within": ${gate.reason}`);
  assert.match(gate.reason, /91 blocks AHEAD/);
});

test("the ahead sentence does NOT claim we agree with the network", () => {
  // The limit worth stating in the string itself: a node far ahead of every
  // external reference is also what a node on its own fork looks like. Height
  // cannot separate those, so the reason must not imply it can.
  const gate = chainFreshness(5_000_000, 4_000_000);
  assert.equal(gate.state, "safe");
  assert.match(gate.reason, /not\s+evidence that we agree with the network/);
});

test("a node exactly level still reads as within, not ahead", () => {
  // lag 0 is the boundary between the two sentences. Off by one here and every
  // healthy in-sync node reports itself as AHEAD by zero blocks.
  const gate = chainFreshness(4_000_000, 4_000_000);
  assert.equal(gate.lag, 0);
  assert.match(gate.reason, /within/);
  assert.doesNotMatch(gate.reason, /AHEAD/);
});

test("a positive lag inside the budget still says within, so the split is narrow", () => {
  // The control. Without it, moving every safe case to the AHEAD sentence would
  // pass the two tests above.
  const gate = chainFreshness(4_000_000 - 2, 4_000_000);
  assert.equal(gate.state, "safe");
  assert.equal(gate.lag, 2);
  assert.match(gate.reason, /within/);
});
