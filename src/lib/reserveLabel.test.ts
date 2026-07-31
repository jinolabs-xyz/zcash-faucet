/**
 * The reserve rows, and every case is a sentence a reader could be misled by.
 *
 * The bug that caused this file: `reserve 257.2 / 1000 TAZ` beside `refill idle` made
 * a healthy faucet look broken, because the fraction named a target nothing was
 * pursuing and "idle" gave no reason. The real numbers from that moment are the first
 * test, so a regression reproduces the exact confusion rather than an invented one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reserveRows } from "./reserveLabel.ts";

const BAND = { lowTaz: 100, targetTaz: 1000 };

test("the reading that caused this: inside the band, idle, and it must explain itself", () => {
  const r = reserveRows({ ...BAND, spendableTaz: 257.2, refilling: false });
  assert.equal(r.reserve, "257.2 TAZ");
  assert.match(r.refill, /starts under 100 TAZ/);
  // The specific misreading. A denominator of 1000 invites "why is it stuck at 26%".
  assert.doesNotMatch(r.reserve, /1000/, "quotes a target nothing is pursuing");
  assert.doesNotMatch(r.refill, /^idle$/, "bare idle is what read as stalled");
});

test("the target appears only while something is aiming at it", () => {
  const r = reserveRows({ ...BAND, spendableTaz: 40, refilling: true });
  assert.match(r.refill, /topping up to 1000 TAZ/);
});

test("below the mark and NOT refilling is called out, not softened to idle", () => {
  // This is a real condition: under the low mark with no refill running means the loop
  // cannot act, usually because shielding is off. Calling it "idle" would hide it
  // behind a word that sounds normal.
  const r = reserveRows({ ...BAND, spendableTaz: 12.5, refilling: false });
  assert.match(r.refill, /BELOW the 100 TAZ mark/);
  assert.doesNotMatch(r.refill, /starts under/, "that wording implies nothing is wrong");
});

test("the low mark is what a reader is told about, in every idle case", () => {
  for (const spendable of [0, 99.9, 100, 257.2, 999]) {
    const r = reserveRows({ ...BAND, spendableTaz: spendable, refilling: false });
    assert.match(r.refill, /100 TAZ/, `no low mark at ${spendable}`);
  }
});

test("an unknown balance says unknown, never 0.0", () => {
  // A wallet that did not answer has not told us the faucet is empty. Same
  // not-seen-versus-cannot-say rule the ledger probe and the tip oracle follow.
  const r = reserveRows({ ...BAND, spendableTaz: null, refilling: false });
  assert.equal(r.reserve, "unknown");
  assert.doesNotMatch(r.reserve, /0\.0/);
});

test("an unknown balance while refilling still reports the target", () => {
  const r = reserveRows({ ...BAND, spendableTaz: null, refilling: true });
  assert.equal(r.reserve, "unknown");
  assert.match(r.refill, /topping up to 1000/);
});

test("exactly at the low mark is not below it, so the boundary is not off by one", () => {
  // decideRefilling triggers under LOW, so 100 with LOW 100 is inside the band and the
  // wording must not accuse the loop of failing to act.
  const r = reserveRows({ ...BAND, spendableTaz: 100, refilling: false });
  assert.match(r.refill, /starts under 100 TAZ/);
  assert.doesNotMatch(r.refill, /BELOW/);
});

/* ------------- wanting to refill versus being able to (the 758/1000 case) --------- */

const STUCK = { outcome: "waiting" as const, reason: "Insufficient balance (have 0, need 10000 including fee)" };

test("refilling while every step throws nothing-to-shield does NOT say topping up", () => {
  // The state the box was actually in: refilling true, 758 of 1000, and every tick
  // throwing because the transparent pool is empty. "Topping up" claimed an action
  // that could not happen.
  const r = reserveRows({ ...BAND, spendableTaz: 758.5, refilling: true, failedSteps: 40, lastFailure: STUCK });
  assert.doesNotMatch(r.refill, /topping up/i, "claims an action nothing can perform");
  assert.match(r.refill, /waiting, nothing to shield/);
});

test("a real error while refilling is named as failing, not softened to waiting", () => {
  const r = reserveRows({
    ...BAND, spendableTaz: 40, refilling: true, failedSteps: 3,
    lastFailure: { outcome: "error", reason: "connection refused" },
  });
  assert.match(r.refill, /FAILING/);
  assert.match(r.refill, /3 consecutive/);
});

test("refilling with no failures still says topping up", () => {
  // The control. Without it, any wording that never says "topping up" would pass.
  const r = reserveRows({ ...BAND, spendableTaz: 40, refilling: true, failedSteps: 0, lastFailure: null });
  assert.match(r.refill, /topping up to 1000 TAZ/);
});

test("a stale lastFailure with the count cleared does not linger", () => {
  // failedSteps is the live signal. If a reason survives a recovery, the panel would
  // report a fault that has already cleared.
  const r = reserveRows({ ...BAND, spendableTaz: 40, refilling: true, failedSteps: 0, lastFailure: STUCK });
  assert.match(r.refill, /topping up/);
});

test("the fields are optional, so an older status payload still renders", () => {
  const r = reserveRows({ ...BAND, spendableTaz: 40, refilling: true });
  assert.match(r.refill, /topping up to 1000 TAZ/);
});

/* ------------- severity, which has to agree with the wording ---------------------- */

test("a line that reads FAILING is flagged, and a line that reads fine is not", () => {
  // The pairing is the point. Deriving severity at the call site is how you get a row
  // that says FAILING without a marker, or a marker on a row that reads normally.
  const failing = reserveRows({ ...BAND, spendableTaz: 40, refilling: true, failedSteps: 3,
    lastFailure: { outcome: "error", reason: "connection refused" } });
  assert.match(failing.refill, /FAILING/);
  assert.equal(failing.refillBad, true);

  const healthy = reserveRows({ ...BAND, spendableTaz: 257.2, refilling: false });
  assert.match(healthy.refill, /starts under/);
  assert.equal(healthy.refillBad, false);
});

test("below the mark and not refilling is flagged, because it cannot recover alone", () => {
  const r = reserveRows({ ...BAND, spendableTaz: 12.5, refilling: false });
  assert.match(r.refill, /BELOW/);
  assert.equal(r.refillBad, true);
});

test("nothing-to-shield is NOT flagged, on purpose", () => {
  // The normal steady state on a testnet where we lose nearly every block race.
  // Marking it would train an operator to ignore the marker, which costs more than
  // this row is worth.
  const r = reserveRows({ ...BAND, spendableTaz: 758.5, refilling: true, failedSteps: 40,
    lastFailure: { outcome: "waiting", reason: "Insufficient balance (have 0)" } });
  assert.match(r.refill, /waiting, nothing to shield/);
  assert.equal(r.refillBad, false);
});

test("a normal top-up is not flagged", () => {
  const r = reserveRows({ ...BAND, spendableTaz: 40, refilling: true });
  assert.match(r.refill, /topping up/);
  assert.equal(r.refillBad, false);
});

test("every SHOUTED line is flagged, so caps and marker cannot disagree", () => {
  // A sweep rather than a case list: any wording that shouts must also be marked.
  const cases = [
    { ...BAND, spendableTaz: 12.5, refilling: false },
    { ...BAND, spendableTaz: 40, refilling: true, failedSteps: 3, lastFailure: { outcome: "error" as const, reason: "x" } },
    { ...BAND, spendableTaz: 758, refilling: true, failedSteps: 40, lastFailure: { outcome: "waiting" as const, reason: "y" } },
    { ...BAND, spendableTaz: 257.2, refilling: false },
    { ...BAND, spendableTaz: 40, refilling: true },
    { ...BAND, spendableTaz: null, refilling: false },
  ];
  for (const c of cases) {
    const r = reserveRows(c);
    // "waiting" is deliberately calm and deliberately unflagged, so it is the one
    // line allowed to contain no capitals and no marker.
    const shouts = /\b[A-Z]{4,}\b/.test(r.refill);
    if (shouts) assert.equal(r.refillBad, true, `"${r.refill}" shouts but is not flagged`);
  }
});
