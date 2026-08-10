import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRefilling, initialRefilling, shouldStartStep } from "./decide.ts";

const levels = { lowZat: 5_0000_0000n, targetZat: 15_0000_0000n }; // 5 / 15 TAZ

test("starts refilling below the low-water mark", () => {
  assert.equal(decideRefilling(false, 4_9999_9999n, levels), true);
});

test("does not start while above low", () => {
  assert.equal(decideRefilling(false, 5_0000_0000n, levels), false);
  assert.equal(decideRefilling(false, 10_0000_0000n, levels), false);
});

test("keeps refilling through the band until target", () => {
  assert.equal(decideRefilling(true, 5_0000_0000n, levels), true);
  assert.equal(decideRefilling(true, 14_9999_9999n, levels), true);
});

test("stops at exactly the target", () => {
  assert.equal(decideRefilling(true, 15_0000_0000n, levels), false);
  assert.equal(decideRefilling(true, 20_0000_0000n, levels), false);
});

test("holds state when the balance is unknown", () => {
  assert.equal(decideRefilling(true, null, levels), true);
  assert.equal(decideRefilling(false, null, levels), false);
});

test("no flapping: balance oscillating around low stays in one refill run", () => {
  // Drop under low, then bounce just above it repeatedly - must stay on.
  let on = decideRefilling(false, 4_0000_0000n, levels);
  for (const bal of [5_1000_0000n, 4_9000_0000n, 6_0000_0000n, 5_5000_0000n]) {
    on = decideRefilling(on, bal, levels);
    assert.equal(on, true);
  }
  // Only crossing the target turns it off.
  assert.equal(decideRefilling(on, 15_0000_0000n, levels), false);
});

test("zero balance starts a refill", () => {
  assert.equal(decideRefilling(false, 0n, levels), true);
});

test("a tick enqueues a step only when refilling with nothing in the way", () => {
  assert.equal(shouldStartStep({ refilling: true, canAct: true, stepInFlight: false, queueDepth: 0 }), true);
});

test("no step when not refilling", () => {
  assert.equal(shouldStartStep({ refilling: false, canAct: true, stepInFlight: false, queueDepth: 0 }), false);
});

test("no second step while one is in flight", () => {
  assert.equal(shouldStartStep({ refilling: true, canAct: true, stepInFlight: true, queueDepth: 0 }), false);
});

test("refill yields whenever user traffic is queued", () => {
  assert.equal(shouldStartStep({ refilling: true, canAct: true, stepInFlight: false, queueDepth: 1 }), false);
  assert.equal(shouldStartStep({ refilling: true, canAct: true, stepInFlight: false, queueDepth: 20 }), false);
});

test("a tick forbidden to move funds does not enqueue a step it cannot finish", () => {
  // Otherwise the loop burns a queue slot on a guaranteed no-op AND records a
  // run of empty sweeps as if it had tried and found nothing (#172).
  assert.equal(
    shouldStartStep({ refilling: true, canAct: false, stepInFlight: false, queueDepth: 0 }),
    false,
  );
});

/* ---------------- the first tick, where there is no previous state -------------- */

// The band the box actually runs, rather than the 5/15 default above. These are the
// numbers from the deploy that lost a refill, so a regression reproduces that and not
// an invented case.
const live = { lowZat: 500_0000_0000n, targetZat: 1000_0000_0000n };

test("THE DEPLOY THAT LOST A REFILL: 758 inside the band resumes, it does not idle", () => {
  // What used to happen: the container restarted mid-refill, `refilling` came back
  // false, 758 is neither below 500 nor at 1000, so decideRefilling HELD the false and
  // the top-up stopped until the balance drained under the low mark.
  assert.equal(initialRefilling(758_0000_0000n, live), true);
  // The old behaviour, kept here so the difference is explicit rather than implied.
  assert.equal(decideRefilling(false, 758_0000_0000n, live), false, "this is what it did before");
});

test("an unreadable balance leaves it UNDECIDED rather than guessing", () => {
  // null is not false. Guessing from a blind spot is the mistake the rest of this
  // loop refuses to make, and a wrong guess here persists: once settled it never
  // returns to null, so a bad first answer would survive every later tick.
  assert.equal(initialRefilling(null, live), null);
});

test("a cold start at or above target does not refill", () => {
  assert.equal(initialRefilling(1000_0000_0000n, live), false);
  assert.equal(initialRefilling(2000_0000_0000n, live), false);
});

test("a cold start below the low mark refills, same as it always did", () => {
  assert.equal(initialRefilling(0n, live), true);
  assert.equal(initialRefilling(499_9999_9999n, live), true);
});

test("the boundary at target is not off by one", () => {
  assert.equal(initialRefilling(999_9999_9999n, live), true);
  assert.equal(initialRefilling(1000_0000_0000n, live), false);
});

test("once decided, hysteresis owns it: reaching target still stops the refill", () => {
  // The resume-inside-the-band choice must not become a loop that never stops. The
  // first tick picks true at 758, and decideRefilling ends it at the target.
  let refilling = initialRefilling(758_0000_0000n, live);
  assert.equal(refilling, true);
  refilling = decideRefilling(refilling, 999_0000_0000n, live);
  assert.equal(refilling, true, "still climbing");
  refilling = decideRefilling(refilling, 1000_0000_0000n, live);
  assert.equal(refilling, false, "resuming on cold start must not mean refilling forever");
});
