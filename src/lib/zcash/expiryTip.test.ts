/**
 * The expiry tip a transparent send stamps (#190).
 *
 * Asserted against the two pure functions, so the branches that only happen when
 * public lightwalletd infrastructure is degraded are reachable without a socket or
 * a mocked module. Same convention as decide.ts and chainFreshness, and it is the
 * reason those branches are tested at all: the interesting cases here are exactly
 * the ones you cannot arrange on demand against real endpoints.
 *
 * The property under test is the asymmetry, and it is worth restating because every
 * assertion below follows from it: under-estimating the tip produces a transaction
 * whose expiry the network has already passed, which can never confirm at any fee
 * and cost us a 7-hour crash loop on 2026-07-29. Over-estimating produces a
 * transaction with longer to live. So the max is correct, not merely convenient.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RATE_LIMIT_SALT = "expiry-tip-test-salt";
const { summarize, disagreement } = await import("./expiryTip.ts");
const { SHIELD_MAX_LAG_BLOCKS } = await import("./shieldGate.ts");

const A = "https://a.example:443";
const B = "https://b.example:443";
const C = "https://c.example:443";

test("takes the MAX, not the first answer, which is the whole point", () => {
  // A answers first in the real client and is 60 blocks behind. callFirst would
  // stamp 4_222_140 + 40 = 4_222_180, which the network passed 20 blocks ago.
  const tip = summarize([
    { endpoint: A, height: 4_222_140 },
    { endpoint: B, height: 4_222_200 },
  ]);
  assert.equal(tip.height, 4_222_200);
  assert.notEqual(tip.height, 4_222_140, "the lagging endpoint decided the expiry");
});

test("one lagging endpoint cannot drag the tip down", () => {
  // The direction that matters. A single stale member of the rotation is exactly
  // the #190 hazard, and taking the max makes it harmless for expiry.
  const tip = summarize([
    { endpoint: A, height: 4_222_200 },
    { endpoint: B, height: 4_000_000 },
    { endpoint: C, height: 4_222_199 },
  ]);
  assert.equal(tip.height, 4_222_200);
});

test("null and zero heights are not treated as heights", () => {
  // A dead endpoint reports null, and a zero would be a parse failure rather than
  // a real tip. Either counted as a height would produce max=0 in the worst case,
  // or an answered count that overstates our corroboration.
  const tip = summarize([
    { endpoint: A, height: null },
    { endpoint: B, height: 0 },
    { endpoint: C, height: 4_222_200 },
  ]);
  assert.equal(tip.height, 4_222_200);
  assert.equal(tip.answered, 1);
  assert.equal(tip.spread, null, "a spread needs two real answers");
});

test("nothing answered is null, for the caller to turn into a refusal", () => {
  const tip = summarize([
    { endpoint: A, height: null },
    { endpoint: B, height: null },
  ]);
  assert.equal(tip.height, null);
  assert.equal(tip.answered, 0);
});

test("a single answer is REPORTED as single-source, because that is #190 unimproved", () => {
  // The condition the issue is about. We still send, since one source is what the
  // code did before and refusing would trade an unmeasured hazard for a certain
  // outage, but it must not be silent: silence is what let a born-expired
  // transaction look like a normal one.
  const tip = summarize([
    { endpoint: A, height: 4_222_200 },
    { endpoint: B, height: null },
  ]);
  const note = disagreement(tip);
  assert.ok(note, "a single-source tip said nothing at all");
  assert.match(note, /ONE source/);
  assert.match(note, /a\.example/, "the note does not say WHICH endpoint we are trusting");
});

test("a spread past the build budget is reported, and names who is behind", () => {
  const behind = 4_222_200 - (SHIELD_MAX_LAG_BLOCKS + 1);
  const tip = summarize([
    { endpoint: A, height: 4_222_200 },
    { endpoint: B, height: behind },
  ]);
  const note = disagreement(tip);
  assert.ok(note, "endpoints disagreeing past the budget was silent");
  assert.match(note, /disagree by/);
  assert.match(note, /b\.example/, "an operator cannot act without knowing which endpoint lags");
  assert.doesNotMatch(note, /a\.example at/, "the leader was listed as behind");
});

test("agreement inside the budget says nothing, so the log stays readable", () => {
  // A check that warns on every send is a check people filter out, and then the
  // real warning goes with it.
  const tip = summarize([
    { endpoint: A, height: 4_222_200 },
    { endpoint: B, height: 4_222_200 - SHIELD_MAX_LAG_BLOCKS },
  ]);
  assert.equal(disagreement(tip), null);
});

test("the budget boundary is exclusive, matching the freshness gate next door", () => {
  // Two thresholds that look the same and behave differently is how someone ends
  // up copying the wrong one.
  const atBudget = summarize([
    { endpoint: A, height: 1000 },
    { endpoint: B, height: 1000 - SHIELD_MAX_LAG_BLOCKS },
  ]);
  const overBudget = summarize([
    { endpoint: A, height: 1000 },
    { endpoint: B, height: 1000 - SHIELD_MAX_LAG_BLOCKS - 1 },
  ]);
  assert.equal(disagreement(atBudget), null, "exactly at the budget should pass");
  assert.ok(disagreement(overBudget), "one block past the budget should report");
});

test("no answers reports nothing, because the caller is already failing", () => {
  // A second message here would just be noise in front of the thrown error, and
  // the thrown error is the one that names every endpoint we asked.
  assert.equal(disagreement(summarize([{ endpoint: A, height: null }])), null);
});

test("asking zero endpoints does not crash", () => {
  // Math.max() with no arguments is -Infinity, which would stamp an expiry of
  // -Infinity + 40 rather than failing. A misconfigured endpoint list must land in
  // the refusal path, not build a transaction from a garbage height.
  const tip = summarize([]);
  assert.equal(tip.height, null);
  assert.equal(tip.answered, 0);
  assert.equal(disagreement(tip), null);
});
