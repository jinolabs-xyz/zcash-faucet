import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRefilling, shouldStartStep } from "./decide.ts";

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
  // Drop under low, then bounce just above it repeatedly — must stay on.
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
