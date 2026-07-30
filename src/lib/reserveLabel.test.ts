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
