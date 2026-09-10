import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRefilling, initialRefilling, shouldHarvest, shouldStartStep } from "./decide.ts";

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

/* ------------------------------------------- harvest: sweep because it is THERE (#26x) */

const HARVEST = { minUTXOs: 50, intervalMs: 3_600_000, lastSweepMoved: true, spendableKnown: true };

test("a known backlog harvests on the next tick, without waiting out the interval", () => {
  // 1346 UTXOs at one batch an hour is a day and a half. The backlog rule is what
  // makes a drain a drain rather than a trickle.
  assert.equal(
    shouldHarvest({ knownRemainingUTXOs: 1346, msSinceLastHarvest: 0, ...HARVEST }),
    true,
  );
  assert.equal(
    shouldHarvest({ knownRemainingUTXOs: 50, msSinceLastHarvest: 0, ...HARVEST }),
    true,
  );
});

test("below the batch size it waits, because a sweep costs a transaction either way", () => {
  assert.equal(
    shouldHarvest({ knownRemainingUTXOs: 49, msSinceLastHarvest: 0, ...HARVEST }),
    false,
  );
  assert.equal(
    shouldHarvest({ knownRemainingUTXOs: 0, msSinceLastHarvest: 0, ...HARVEST }),
    false,
  );
});

test("the interval is what notices new coinbase, since an idle loop cannot see it arrive", () => {
  // remainingUTXOs only updates when a sweep reports it, so a wallet that was empty
  // an hour ago says nothing about the blocks mined since. The sweep is the probe.
  assert.equal(
    shouldHarvest({ knownRemainingUTXOs: 0, msSinceLastHarvest: 3_600_000, ...HARVEST }),
    true,
  );
  assert.equal(
    shouldHarvest({ knownRemainingUTXOs: 0, msSinceLastHarvest: 3_599_999, ...HARVEST }),
    false,
  );
});

test("never having harvested is due, not idle", () => {
  assert.equal(
    shouldHarvest({ knownRemainingUTXOs: null, msSinceLastHarvest: null, ...HARVEST }),
    true,
  );
});

test("an UNREPORTED count is not a reported zero", () => {
  // classifySweep keeps count-not-reported distinct for the same reason: an absence
  // of information must not read as a fact. Null falls through to the interval
  // rather than being treated as "nothing to do".
  assert.equal(
    shouldHarvest({ knownRemainingUTXOs: null, msSinceLastHarvest: 0, ...HARVEST }),
    false,
  );
  assert.equal(
    shouldHarvest({ knownRemainingUTXOs: null, msSinceLastHarvest: 3_600_000, ...HARVEST }),
    true,
  );
});

test("A SWEEP THAT MOVED NOTHING DROPS BACK TO THE INTERVAL, however many UTXOs remain", () => {
  // The termination argument. A fruitless sweep is not a failure - the step returned,
  // so failedSteps resets and backoffTicks(0) is 0 - so nothing upstream rate-limits
  // it. Without the moved check this is a sweep every tick, for ever, and it is the
  // ROUTINE case on a mining faucet: coinbase needs 100 confirmations, so there is
  // normally a heap of transparent UTXOs z_shieldcoinbase cannot touch yet. It is
  // #172's present-but-unspendable shape too.
  assert.equal(
    shouldHarvest({ ...HARVEST, lastSweepMoved: false, knownRemainingUTXOs: 1346, msSinceLastHarvest: 0 }),
    false,
    "1346 unspendable UTXOs must not mean a sweep every tick",
  );
  // ...and the hourly probe still runs, so maturing coinbase is picked up.
  assert.equal(
    shouldHarvest({ ...HARVEST, lastSweepMoved: false, knownRemainingUTXOs: 1346, msSinceLastHarvest: 3_600_000 }),
    true,
  );
});

test("progress is what earns the fast path: moved plus a backlog keeps draining", () => {
  assert.equal(
    shouldHarvest({ ...HARVEST, lastSweepMoved: true, knownRemainingUTXOs: 1346, msSinceLastHarvest: 0 }),
    true,
  );
});

test("interval 0 turns harvesting off outright, backlog included", () => {
  // The only way back to demand-only behaviour, and it has to beat the backlog rule
  // or "off" would not mean off.
  assert.equal(
    shouldHarvest({ knownRemainingUTXOs: 5000, msSinceLastHarvest: null, lastSweepMoved: true, spendableKnown: true, minUTXOs: 50, intervalMs: 0 }),
    false,
  );
});

test("a harvest starts a step even when the balance is comfortable", () => {
  // The whole point: refilling false, plenty shielded, and coinbase still gets swept.
  assert.equal(
    shouldStartStep({ refilling: false, harvesting: true, canAct: true, stepInFlight: false, queueDepth: 0 }),
    true,
  );
});

test("a harvest yields to exactly what a refill yields to", () => {
  const base = { refilling: false, harvesting: true, canAct: true, stepInFlight: false, queueDepth: 0 };
  assert.equal(shouldStartStep({ ...base, canAct: false }), false, "shielding not permitted");
  assert.equal(shouldStartStep({ ...base, stepInFlight: true }), false, "one step at a time");
  assert.equal(shouldStartStep({ ...base, queueDepth: 1 }), false, "user traffic first");
});

test("no harvest and no refill still means no step", () => {
  assert.equal(
    shouldStartStep({ refilling: false, harvesting: false, canAct: true, stepInFlight: false, queueDepth: 0 }),
    false,
  );
  // And omitting the field entirely is the pre-harvest meaning, unchanged.
  assert.equal(
    shouldStartStep({ refilling: false, canAct: true, stepInFlight: false, queueDepth: 0 }),
    false,
  );
});

test("A BLIND LOOP DOES NOT BROADCAST, however overdue the harvest is", () => {
  // safeBalance swallows every error, so a wallet whose status call answers while its
  // balance call times out passes the shield gate. A fresh process also has a null
  // clock, which reads as due. Composed, that was a shielding transaction every tick
  // while the loop had established nothing about its own reserve - measured by review
  // as three blind ticks, three broadcasts. "Undecided must not act" is not a refill
  // rule, it is the loop's rule.
  assert.equal(
    shouldHarvest({ ...HARVEST, spendableKnown: false, knownRemainingUTXOs: null, msSinceLastHarvest: null }),
    false,
    "a fresh process that cannot read its balance must not sweep",
  );
  assert.equal(
    shouldHarvest({ ...HARVEST, spendableKnown: false, knownRemainingUTXOs: 1346, msSinceLastHarvest: 86_400_000 }),
    false,
    "a day overdue with a known backlog is still no reason to act blind",
  );
  // And it resumes the moment a balance is readable again.
  assert.equal(
    shouldHarvest({ ...HARVEST, spendableKnown: true, knownRemainingUTXOs: null, msSinceLastHarvest: 86_400_000 }),
    true,
  );
});

test("the harvest minimum defaults to ONE shield batch, and the two stay in step", async () => {
  // CONFIGURATION.md calls FAUCET_HARVEST_MIN_UTXOS "the size of one z_shieldcoinbase
  // batch". That is only true while the default equals SHIELD_UTXO_LIMIT, and they are
  // separate literals in separate files - config.ts importing the refiller would be a
  // cycle, so the seam is asserted here instead. Raising one without the other breaks
  // the drain rationale silently: below the limit the loop stops before a batch is
  // full, above it the backlog rule can never fire.
  const { SHIELD_UTXO_LIMIT } = await import("./zalletRefiller.ts");
  const { config } = await import("../config.ts");
  assert.equal(config.reserve.harvestMinUTXOs, SHIELD_UTXO_LIMIT);

  // And it is validated the same way as the interval beside it. One PR shipped both and
  // gave them opposite rules: -1 and 0.5 threw for the seconds and were silently rounded
  // to 1 for the count. The cost differs, the shape does not - the value in force was
  // not the value someone set, and nothing said so.
  const { wholeCount } = await import("../config.ts");
  const key = "FAUCET_HARVEST_MIN_UTXOS";
  const restore = process.env[key];
  try {
    process.env[key] = "1";
    assert.equal(wholeCount(key, 50), 1);
    for (const bad of ["-1", "0", "0.5", "2.5"]) {
      process.env[key] = bad;
      assert.throws(() => wholeCount(key, 50), /whole number of 1 or more/, `${bad} must be refused`);
    }
  } finally {
    if (restore === undefined) delete process.env[key];
    else process.env[key] = restore;
  }
});

test("the harvest interval defaults to an hour, and a typo cannot silently disable it", async () => {
  // This default IS the fee rate: it decides how often an unattended faucet broadcasts a
  // shielding transaction forever. Nothing pinned it, so changing 3600 to 1 - a shield
  // every tick on every default deployment - passed the whole suite. harvestWiring.test.ts
  // sets the env var explicitly and so is immune to its own default; this is the seam.
  const { config } = await import("../config.ts");
  assert.equal(config.reserve.harvestIntervalSeconds, 3600);

  // 0 is the documented off switch and must keep working. -1 and 0.5 used to CLAMP to 0,
  // which turned a typo into that off switch and stranded the money again in silence.
  const { wholeSeconds } = await import("../config.ts");
  const key = "FAUCET_HARVEST_INTERVAL_SECONDS";
  const restore = process.env[key];
  try {
    process.env[key] = "0";
    assert.equal(wholeSeconds(key, 3600), 0);
    for (const bad of ["-1", "0.5", "-0.5"]) {
      process.env[key] = bad;
      assert.throws(() => wholeSeconds(key, 3600), /whole number of seconds/, `${bad} must be refused`);
    }
  } finally {
    if (restore === undefined) delete process.env[key];
    else process.env[key] = restore;
  }
});
