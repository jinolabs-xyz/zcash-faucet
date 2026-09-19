/**
 * The wait we ask a refused visitor to sit through, per failure.
 *
 * The owner met this on their phone: a card reading "Our side, not yours" and "your cooldown is
 * untouched" above a button disabled for 71 seconds. Telling someone it is our fault and locking
 * them out anyway is not a wording problem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { freshnessRetrySecondsForTest } = await import("./retry-hint.ts");

test("a node that did not answer is a wobble, not a block to wait out", () => {
  // MEASURED ON PROD 2026-09-19: eight reads in ten answered under 3s while the node was 100%
  // synced. Nothing about the chain is wrong and no block needs to pass, so 75s - "roughly one
  // testnet block" - is punishing a visitor for our own slow read.
  const quick = freshnessRetrySecondsForTest("unverifiable", null);
  assert.ok(quick <= 10, `a wobble should clear in seconds; got ${quick}s`);
});

test("a node that is genuinely behind still waits a block, because that is what helps", () => {
  const behind = freshnessRetrySecondsForTest("behind", 4_367_000);
  assert.equal(behind, 75);
});

test("the three failures get three different waits, asserted as differing", () => {
  // L51: asserting each against a threshold could be satisfied by one number for all three. The
  // property is that they DIFFER, because they are different failures.
  const a = freshnessRetrySecondsForTest("unverifiable", null);        // our node was silent
  const b = freshnessRetrySecondsForTest("unverifiable", 4_367_000);   // the reference was
  const c = freshnessRetrySecondsForTest("behind", 4_360_000);         // we are behind
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
  assert.ok(a < b && b < c, `waits should grow with how much is actually wrong; got ${a}/${b}/${c}`);
});
