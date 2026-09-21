/**
 * The money gate judges our node against the HIGHEST NON-STALE reference (#548), not
 * against whichever one the oracle happened to cache.
 *
 * WHY THIS IS A NARROW BUG AND STILL A REAL ONE. The lag budget is five blocks, so a
 * stale reference only fools the gate when it sits CLOSE to our own height while the real
 * tip is further ahead. The scenario below is not invented: at 14:01Z on 2026-09-15 hosh
 * read 4,349,808 while our own endpoint read 4,349,928, a 120-block disagreement inside a
 * quarter of an hour. A node at 4,349,805 is 3 behind the stale one - inside the budget,
 * allowed - and 123 behind the truth, which is past the tip+40 window a shielded
 * transaction expires in.
 *
 * These drive readChainFreshness, which takes no injectable reader, so they exercise the
 * DEFAULT - the thing that actually runs in production. A test that passed its own reader
 * would prove the pure function and nothing about which tip the gate reaches for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// The readers under test KICK a background refresh when the cache is old (that kick is
// what #555's review found missing), so this file pins the oracle at a closed port and an
// empty direct list before importing: a unit test must never be able to dial the real one.
process.env.HOSH_URL = "http://127.0.0.1:9/";
process.env.TIP_ORACLE_ENDPOINT = "";
// The THIRD leg: chainIdentityOracle dials LIGHTWALLETD_ENDPOINT directly (config.ts:116).
process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:9";
const { readChainFreshness, readChainFreshnessAsking, SHIELD_MAX_LAG_BLOCKS } = await import("./shieldGate.ts");
const { resetExternalTipForTests, MAX_AGE_MS_FOR_TESTS } = await import("./externalTip.ts");

const STALE_HOSH = 4_349_808; // what hosh said at 14:01Z
const TRUE_TIP = 4_349_928; // what our own endpoint said at the same moment
const NODE = 4_349_805; // 3 behind the stale one, 123 behind the truth

type Src = { height: number; at: number; host: string | null };
const g = globalThis as unknown as { __faucetTipSources?: Record<string, Src> };
const plant = (s: Record<string, { height: number; ageMs: number }>) => {
  resetExternalTipForTests();
  g.__faucetTipSources = Object.fromEntries(
    Object.entries(s).map(([k, v]) => [k, { height: v.height, at: Date.now() - v.ageMs, host: null }]),
  );
};

test("the budget is small enough that this bug needs a CLOSE stale reference, not just a stale one", () => {
  assert.equal(SHIELD_MAX_LAG_BLOCKS, 5, "if this ever widens, the scenario below has to be re-derived");
});

test("a stale reference close to our height cannot wave a drip through when another source knows better", () => {
  plant({ hosh: { height: STALE_HOSH, ageMs: 1000 }, lightwalletd: { height: TRUE_TIP, ageMs: 1000 } });
  const gate = readChainFreshness(NODE);
  assert.equal(gate.lag, TRUE_TIP - NODE, "judged against the higher reference, not the closer one");
  assert.equal(gate.state, "unsafe");
  // And the old behaviour, so the difference is visible rather than asserted: against the
  // stale reference alone the same node is three blocks behind and would have been sent.
  assert.ok(STALE_HOSH - NODE <= SHIELD_MAX_LAG_BLOCKS, "3 blocks is inside the budget");
});

test("taking the max can only refuse more, never less", () => {
  // The fresher source is the HIGHER one, so the max is the more pessimistic story. A node
  // genuinely at the tip still passes with both references present.
  plant({ hosh: { height: TRUE_TIP - 1, ageMs: 1000 }, lightwalletd: { height: TRUE_TIP, ageMs: 1000 } });
  assert.equal(readChainFreshness(TRUE_TIP).state, "safe");
  assert.equal(readChainFreshness(TRUE_TIP - SHIELD_MAX_LAG_BLOCKS).state, "safe", "exactly at the budget still sends");
  assert.equal(readChainFreshness(TRUE_TIP - SHIELD_MAX_LAG_BLOCKS - 1).state, "unsafe", "one past it does not");
});

test("a stale source cannot be the one we judge against, even when it is the only one left", () => {
  plant({ hosh: { height: STALE_HOSH, ageMs: MAX_AGE_MS_FOR_TESTS + 1 } });
  const gate = readChainFreshness(NODE);
  assert.equal(gate.state, "unverifiable", "we looked, the answer is too old, and we say so rather than sending");
  assert.equal(gate.lag, null);
});

test("the ASKING reader on the money path uses the same references, not the old single value", async () => {
  // The second call site, and the one a mutation caught me leaving uncovered: every
  // existing test of this function passes its own reader, so the DEFAULT - the thing the
  // claim path actually runs - was proven by nothing. `undefined` here takes the default
  // reader while still stubbing the warm, which is the only way to exercise it.
  plant({ hosh: { height: STALE_HOSH, ageMs: 1000 }, lightwalletd: { height: TRUE_TIP, ageMs: 1000 } });
  const gate = await readChainFreshnessAsking(NODE, 200, undefined, async () => {});
  assert.equal(gate.lag, TRUE_TIP - NODE, "the claim path judges against the higher reference too");
  assert.equal(gate.state, "unsafe");
});

test("with one fresh source the gate is exactly as good as that source, which is the limit worth stating", () => {
  // No second opinion, so a stale-but-recently-fetched number still governs. Only
  // corroboration catches that, and hosh publishes no timestamp for us to check.
  plant({ hosh: { height: STALE_HOSH, ageMs: 1000 } });
  assert.equal(readChainFreshness(NODE).state, "safe", "3 behind the only reference we have");
});
