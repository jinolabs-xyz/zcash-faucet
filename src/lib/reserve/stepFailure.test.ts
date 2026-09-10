/**
 * Classification and backoff for a refill step that threw.
 *
 * The first test is the exact message from the box, because that is the failure that
 * ran unnoticed every tick while every counter on /api/status read clean.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStepFailure, backoffTicks, shouldAttempt, MAX_BACKOFF_TICKS } from "./stepFailure.ts";

const REAL = "zallet RPC z_shieldcoinbase: Failed to propose shielding transaction: Insufficient balance (have 0, need 10000 including fee) (code -4)";

test("the message that ran unnoticed every tick is WAITING, not an error", () => {
  // No mined coinbase to shield is the normal state on a testnet where we lose almost
  // every block race. Alarming on it every 30 seconds is how a real fault gets lost.
  assert.equal(classifyStepFailure(REAL), "waiting");
});

test("an unrecognised failure is an ERROR, so new breakage arrives loud", () => {
  // The default matters more than the patterns. Absorbing an unknown message into
  // "waiting" is exactly the silence this change exists to remove.
  for (const m of ["connection refused", "wallet is locked", "", "ECONNRESET", "proof failed"]) {
    assert.equal(classifyStepFailure(m), "error", `"${m}" should not be treated as waiting`);
  }
});

test("insufficient balance with dust present is still waiting", () => {
  // Same condition, non-zero `have`, still nothing worth sweeping rather than a fault.
  assert.equal(classifyStepFailure("Insufficient balance (have 4200, need 10000 including fee)"), "waiting");
});

test("no backoff until something has actually failed", () => {
  assert.equal(backoffTicks(0), 0);
  assert.equal(shouldAttempt(0, 0), true, "a healthy loop must attempt every tick");
});

test("backoff doubles and then stops doubling", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(backoffTicks), [1, 2, 4, 8, 16, 20]);
  assert.equal(backoffTicks(50), MAX_BACKOFF_TICKS, "must not grow without bound");
});

test("the cap keeps retries frequent enough to catch a new coinbase", () => {
  // 20 ticks at the default 30s is 10 minutes. If this grows, a block we do win could
  // sit unswept for hours, which is the opposite of the problem being solved.
  assert.ok(MAX_BACKOFF_TICKS * 30 <= 600, `${MAX_BACKOFF_TICKS} ticks is over ten minutes at 30s`);
});

test("a tick inside the backoff window is skipped, one at the edge is not", () => {
  // 3 failures means wait 4 ticks.
  assert.equal(shouldAttempt(3, 3), false);
  assert.equal(shouldAttempt(3, 4), true, "off by one here doubles every backoff");
});

test("recovery is immediate: one success and the next tick attempts again", () => {
  // The counter resetting is the reconciler's job, but the rule has to allow it.
  assert.equal(shouldAttempt(0, 0), true);
});

test("a wallet resyncing after a reorg is its OWN state, not a fault and not nothing-to-shield", () => {
  // Observed verbatim on the box, 2026-09-10, while the faucet was serving normally:
  // a solo-mining faucet on a public testnet loses block races, the wallet rewinds,
  // refuses spends for a few minutes and heals itself. Classified as `error` it painted
  // a red "FAILING, N consecutive" across the panel and console.error'd every tick
  // through a transient that needed nobody, which is how a real fault gets ignored.
  assert.equal(
    classifyStepFailure(
      "zallet RPC z_shieldcoinbase: Wallet is recovering from a chain reorganization " +
        "(rolled back to 4337568); balance and spend operations are unavailable until " +
        "it has resynced (code -2)",
    ),
    "resyncing",
  );
  // Both spellings, because the wallet's is American and ours is not.
  assert.equal(classifyStepFailure("recovering from a chain reorganisation"), "resyncing");
  // And NARROW: the default is `error` on purpose, so a message that merely mentions a
  // reorg must not be absorbed into the quiet bucket.
  assert.equal(classifyStepFailure("reorg detected, wallet database is corrupt"), "error");
});
