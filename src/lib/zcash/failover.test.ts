import { test } from "node:test";
import assert from "node:assert/strict";
import { createFailoverBudget, FAILOVER_BUDGET_MULTIPLIER } from "./failover.ts";

/** A clock we drive by hand, so these assert the policy and not the wall time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("the first attempt gets the full per-attempt timeout", () => {
  const clock = fakeClock();
  const budget = createFailoverBudget(6000, clock.now);
  assert.equal(budget.next(), 6000);
});

test("a full-length hang still leaves a genuine second attempt", () => {
  const clock = fakeClock();
  const budget = createFailoverBudget(6000, clock.now);
  budget.next();
  clock.advance(6000); // endpoint 1 hung until its deadline

  // This is the whole reason the multiplier is 2 and not 1. At 1x the second
  // endpoint would get nothing and the failover list would be decorative.
  assert.equal(budget.next(), 6000);
});

test("two full-length hangs exhaust the budget, so the loop stops", () => {
  const clock = fakeClock();
  const budget = createFailoverBudget(6000, clock.now);
  clock.advance(6000);
  clock.advance(6000);
  assert.equal(budget.next(), 0, "0 tells the caller to stop rather than pass a negative deadline");
});

test("the total is bounded at the multiplier, which is the point of #89", () => {
  const clock = fakeClock();
  const perAttempt = 6000;
  const budget = createFailoverBudget(perAttempt, clock.now);

  // Ten configured endpoints, every one of them hanging. Before this the cost
  // was 10 x 6s on a user-facing GET.
  let spent = 0;
  for (let i = 0; i < 10; i++) {
    const slice = budget.next();
    if (slice === 0) break;
    clock.advance(slice);
    spent += slice;
  }
  assert.equal(spent, perAttempt * FAILOVER_BUDGET_MULTIPLIER);
});

test("endpoints that fail fast do not spend the budget, so every entry is tried", () => {
  const clock = fakeClock();
  const budget = createFailoverBudget(6000, clock.now);

  // Connection refused comes back in milliseconds. A healthy-but-wrong list
  // must not be truncated by the cap.
  let tried = 0;
  for (let i = 0; i < 8; i++) {
    if (budget.next() === 0) break;
    clock.advance(5); // refused, near-instant
    tried++;
  }
  assert.equal(tried, 8);
});

test("a later attempt is trimmed to the remainder rather than getting a fresh slice", () => {
  const clock = fakeClock();
  const budget = createFailoverBudget(6000, clock.now);
  clock.advance(6000); // one full hang
  clock.advance(2000); // then a slower-than-instant failure
  assert.equal(budget.next(), 4000);
});
