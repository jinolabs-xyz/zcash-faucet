import { test } from "node:test";
import assert from "node:assert/strict";
import {
  solvableCeilingBits,
  ttlSecondsFor,
  solveSecondsFor,
  expectedHashes,
  SLOW_BROWSER_HASHES_PER_SEC,
  SOLVE_BUDGET_FRACTION,
} from "./powBudget.ts";

/** Shipped defaults, so these numbers are the ones production uses. */
const BASE_BITS = 20;
const BASE_TTL = 180;

test("THE INVARIANT: every difficulty the gate can issue solves inside its budget", () => {
  // This is the test #132 existed for. It walks EVERY issuable bit level rather
  // than spot-checking, because the bug was at the top of the range and a
  // sampled test would have skipped it.
  const ceiling = solvableCeilingBits(BASE_BITS, BASE_TTL);
  for (let bits = BASE_BITS; bits <= ceiling; bits++) {
    const ttl = ttlSecondsFor(bits, BASE_BITS, BASE_TTL);
    const solve = solveSecondsFor(bits);
    assert.ok(
      solve <= ttl * SOLVE_BUDGET_FRACTION,
      `${bits} bits: ${solve.toFixed(0)}s to solve against a ${(ttl * SOLVE_BUDGET_FRACTION).toFixed(0)}s budget`,
    );
  }
});

test("the live failure is now unrepresentable", () => {
  // Measured on the live site: 26 bits issued with a flat 180s TTL, ~195s to
  // solve in a browser, so it expired before it could be answered.
  const ceiling = solvableCeilingBits(BASE_BITS, BASE_TTL);
  assert.ok(ceiling < 26, `26 bits must be above the ceiling, ceiling is ${ceiling}`);
  assert.equal(ceiling, 23);

  // And the reason, stated as arithmetic rather than as a comment.
  assert.ok(solveSecondsFor(26) > ttlSecondsFor(26, BASE_BITS, BASE_TTL));
});

test("scaling the TTL alone would NOT have fixed it, which is why the ceiling exists", () => {
  // Work grows exponentially with bits and a linear TTL cannot catch it. At 26
  // bits the scaled TTL is 234s against 671s of solving on a slow phone.
  const ttl26 = ttlSecondsFor(26, BASE_BITS, BASE_TTL);
  assert.equal(ttl26, 234);
  assert.ok(solveSecondsFor(26) > ttl26, "a linear TTL bump does not make 26 bits solvable");
});

test("a longer TTL earns a higher ceiling, and a shorter one lowers it", () => {
  // The knobs stay usable: an operator who wants a harder gate can buy it with
  // time rather than by making the gate impossible.
  assert.ok(solvableCeilingBits(BASE_BITS, 600) > solvableCeilingBits(BASE_BITS, BASE_TTL));
  assert.ok(solvableCeilingBits(BASE_BITS, 30) < solvableCeilingBits(BASE_BITS, BASE_TTL));
});

test("faster hardware would earn a higher ceiling, which is why the constant is pessimistic", () => {
  // Measured for real: 467k in headless Chromium here, 344k on QA's box. The
  // shipped constant is 100k because a phone is the device that matters.
  const onThisLaptop = solvableCeilingBits(BASE_BITS, BASE_TTL, 467_000);
  const onAPhone = solvableCeilingBits(BASE_BITS, BASE_TTL, SLOW_BROWSER_HASHES_PER_SEC);
  assert.ok(onThisLaptop > onAPhone, "a dev laptop would justify a higher ceiling than a phone");
  assert.equal(SLOW_BROWSER_HASHES_PER_SEC, 100_000);
});

test("the ceiling never drops below the base, so the gate always issues something", () => {
  // Even with an absurdly short TTL the base difficulty is still offered rather
  // than the function returning something unusable.
  assert.equal(solvableCeilingBits(BASE_BITS, 1), BASE_BITS);
});

test("ttl does not shrink below the base for easy challenges", () => {
  assert.equal(ttlSecondsFor(BASE_BITS, BASE_BITS, BASE_TTL), BASE_TTL);
  assert.equal(ttlSecondsFor(BASE_BITS - 5, BASE_BITS, BASE_TTL), BASE_TTL);
});

test("expectedHashes is the plain 2^bits the difficulty means", () => {
  assert.equal(expectedHashes(20), 1_048_576);
  assert.equal(expectedHashes(26), 67_108_864);
});
