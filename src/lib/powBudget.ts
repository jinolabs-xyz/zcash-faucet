/**
 * How hard a proof-of-work challenge may get, and how long it lives (#132).
 *
 * Arithmetic only, no imports, so the invariant can be asserted in a test
 * without dragging config or the ledger in. Same shape as sendBudget.ts.
 *
 * THE INVARIANT, and it is the whole point of this file: the hardest challenge
 * the gate will ever issue must be solvable, in a browser, well inside its own
 * lifetime. Break that and the gate stops being anti-abuse and becomes an
 * outage that only affects people who tried more than once.
 *
 * It was broken on the live site: a 26-bit ceiling against a flat 180s TTL,
 * measured at ~195s to solve, so the challenge expired before it could be
 * answered and the 403 invited a retry that re-armed the same trap.
 */

/**
 * The slowest browser we design for, in hashes per second.
 *
 * Measured with the real public/pow-worker.js, not estimated: 467,000 H/s in
 * headless Chromium on a dev laptop, and QA measured 344,000 on different
 * hardware. A mid-range phone runs a few times slower than either, so 100,000
 * is the floor worth protecting.
 *
 * Deliberately pessimistic. Being wrong high here does not cost performance, it
 * costs a real person on a real phone their claim, and they cannot tell the
 * difference between "too hard" and "broken".
 *
 * THE HONEST LEVER. If the gate needs to be harder, buy it with a longer TTL.
 * Do NOT raise it by inflating this number and do NOT raise maxBits past the
 * ceiling, because neither makes anyone's phone faster: both just move the
 * ceiling above what a browser can answer, which is how #132 happened.
 *
 * Worth knowing what this constant is: the ONE input to the ceiling that cannot
 * be derived from the code or checked at runtime. It is a claim about hardware
 * we do not own and cannot measure from here, so it is the number most likely to
 * be quietly wrong, and the only defence is keeping it pessimistic on purpose.
 */
export const SLOW_BROWSER_HASHES_PER_SEC = 100_000;

/**
 * Fraction of a challenge's life the solve is allowed to take. The rest is
 * headroom for a slower device, a busy tab, and the round trip.
 */
export const SOLVE_BUDGET_FRACTION = 0.5;

/** Expected hashes to find `bits` leading zero bits. */
export function expectedHashes(bits: number): number {
  return 2 ** bits;
}

/**
 * A harder challenge gets proportionally longer to live. This helps, but note
 * what it cannot do: work grows exponentially with bits and this grows linearly,
 * so scaling the TTL alone never restores solvability. It is a cushion. The
 * ceiling below is what actually holds the invariant.
 */
export function ttlSecondsFor(bits: number, baseBits: number, baseTtlSeconds: number): number {
  if (bits <= baseBits) return baseTtlSeconds;
  return Math.round(baseTtlSeconds * (bits / baseBits));
}

/** Expected seconds to solve `bits` on the slow browser above. */
export function solveSecondsFor(bits: number, hashesPerSec = SLOW_BROWSER_HASHES_PER_SEC): number {
  return expectedHashes(bits) / hashesPerSec;
}

/**
 * The hardest difficulty that still solves inside its solve budget. Anything
 * above this is a challenge we would issue and nobody could answer.
 *
 * Searched rather than solved in closed form because the TTL is itself a
 * function of bits, and an integer walk over a range this small is clearer than
 * inverting it.
 */
export function solvableCeilingBits(
  baseBits: number,
  baseTtlSeconds: number,
  hashesPerSec = SLOW_BROWSER_HASHES_PER_SEC,
): number {
  let best = baseBits;
  for (let bits = baseBits; bits <= 40; bits++) {
    const budget = ttlSecondsFor(bits, baseBits, baseTtlSeconds) * SOLVE_BUDGET_FRACTION;
    if (solveSecondsFor(bits, hashesPerSec) > budget) break;
    best = bits;
  }
  return best;
}
