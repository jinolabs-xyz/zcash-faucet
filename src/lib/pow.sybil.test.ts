/**
 * The Sybil-hardening properties of the PoW gate (#196).
 *
 * Its own file because config reads env once at module load, and these need the
 * SHIPPED defaults rather than the tiny profile pow.escalation.test.ts pins to
 * keep itself fast. The point here is what a real deployment does.
 *
 * The framing that produced these tests, because the numbers are the argument:
 * draining the entire 100 TAZ daily cap costs a farmer about 3.5 core-minutes on
 * one cloud core, against 175 core-minutes for the phone we design for. PoW taxes
 * honest users roughly 50x harder than the attacker it aims at, so it is a rate
 * limiter and not a Sybil defence. What it CAN do is charge a repeat offender, and
 * these assertions are about that being true and staying true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-pow-sybil-")));
process.env.RATE_LIMIT_SALT = "sybil-test-salt";

const { config } = await import("./config.ts");
const { solvableCeilingBits, solveSecondsFor, SLOW_BROWSER_HASHES_PER_SEC } = await import("./powBudget.ts");
const { REQ_WINDOW_MS } = await import("./pow.ts");

test("a first-time claimer still pays the base, so hardening cost them nothing", () => {
  // The whole design constraint. Every lever here targets repeat attempts, and if
  // this number moves, someone has started taxing honest users instead.
  assert.equal(config.pow.baseBits, 20);
  const seconds = solveSecondsFor(config.pow.baseBits);
  assert.ok(seconds < 15, `a first claim costs ${seconds.toFixed(1)}s on the slow phone, too much`);
});

test("the ceiling leaves real escalation headroom, which is what charges a farmer", () => {
  // 180s TTL put this at 23, giving 3 bits (8x). The TTL raise buys 5 bits (32x).
  // If this drops back toward the base, escalation has quietly stopped existing.
  const ceiling = solvableCeilingBits(config.pow.baseBits, config.pow.ttlSeconds);
  const headroom = ceiling - config.pow.baseBits;
  assert.ok(headroom >= 5, `only ${headroom} bits of headroom (ceiling ${ceiling}), escalation cannot bite`);
});

test("the hardest challenge we would ever issue is still solvable on a phone", () => {
  // #132, restated as an assertion rather than a comment. The ceiling is derived
  // from the TTL, so raising the TTL to buy headroom must not outrun it.
  const ceiling = solvableCeilingBits(config.pow.baseBits, config.pow.ttlSeconds);
  const budget = (config.pow.ttlSeconds * (ceiling / config.pow.baseBits)) / 2;
  assert.ok(
    solveSecondsFor(ceiling) <= budget,
    `${ceiling} bits takes ${solveSecondsFor(ceiling).toFixed(0)}s against a ${budget.toFixed(0)}s budget`,
  );
});

test("raising the BASE would eat the headroom, which is why we did not", () => {
  // The finding that changed the plan. maxBits is already clamped by the ceiling,
  // so a higher base does not make the gate harder, it makes escalation shallower
  // AND every first claim slower. Kept as a test so the next person proposing it
  // sees the arithmetic instead of rediscovering it.
  const ttl = config.pow.ttlSeconds;
  const atBase = solvableCeilingBits(config.pow.baseBits, ttl) - config.pow.baseBits;
  const atBasePlus2 = solvableCeilingBits(config.pow.baseBits + 2, ttl) - (config.pow.baseBits + 2);
  assert.ok(
    atBasePlus2 < atBase,
    `raising the base by 2 changed headroom from ${atBase} to ${atBasePlus2}, expected it to shrink`,
  );
  assert.ok(solveSecondsFor(config.pow.baseBits + 2) > 3 * solveSecondsFor(config.pow.baseBits));
});

test("the escalation window is long enough that pacing is not free", () => {
  // At 10 minutes, one attempt every 11 minutes reset escalation entirely and a
  // farmer paid base difficulty forever. This is the cheapest lever that targets
  // farming rather than everyone, because a real user claims once and never
  // notices the window at all.
  //
  // Reads the SHIPPED constant. My first version of this recomputed the default
  // as `Number(env ?? 3600)`, which is a second copy of the rule: change the real
  // default to 600 and the test would still have passed. That is rule 15 in a
  // three-line test.
  assert.ok(
    REQ_WINDOW_MS >= 30 * 60_000,
    `a ${REQ_WINDOW_MS / 60_000} minute window makes pacing cheap again`,
  );
});

test("the pessimistic browser floor is unchanged, because it is a claim about hardware", () => {
  // The one input to the ceiling that cannot be derived or checked at runtime
  // (#132, and CONTRIBUTING rule 16). Buying headroom with the TTL is honest.
  // Buying it by inflating this is how you issue challenges nobody can answer.
  assert.equal(SLOW_BROWSER_HASHES_PER_SEC, 100_000);
});
