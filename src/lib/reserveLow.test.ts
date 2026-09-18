/**
 * THE GATE, EVERY PHASE, ONE ROW EACH.
 *
 * #659 moved this panel out of the claim card because the reserve is a fact about the wallet
 * and not a step in the claim - and then it was gated on `phase === "ready"`, so it vanished
 * the moment a claim started. The owner caught it in TWO states, proof-of-work and
 * rate-limited, which is the signature of a rule nobody had enumerated.
 *
 * So the table below is the point of this file: every Phase is listed, and adding a twelfth
 * fails the last row until someone decides which side it falls on. A gate with a table cannot
 * quietly acquire a new hole.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reserveLowVisible } from "./reserveLow.ts";
import type { Phase } from "./faucetPhase.ts";

const LOW = { spendableTaz: 4504, lowTaz: 5000, refilling: true };

const SHOWN: Phase[] = ["queued", "ready", "submitting", "success", "cooldown", "error"];
const HIDDEN: Phase[] = ["checking", "syncing", "fault", "empty", "degraded"];

test("the panel survives a claim - submitting and cooldown are the two the owner caught", () => {
  // Named separately from the table because these two ARE the bug report. If a later edit
  // re-gates on a claim phase, this row says which states regressed rather than "a phase moved".
  assert.equal(reserveLowVisible("submitting", LOW, "taz"), true, "proof-of-work must not hide the reserve");
  assert.equal(reserveLowVisible("cooldown", LOW, "taz"), true, "being rate-limited must not hide the reserve");
});

test("every phase is decided, and the list is exhaustive", () => {
  for (const p of SHOWN) assert.equal(reserveLowVisible(p, LOW, "taz"), true, `${p} should show the reserve notice`);
  for (const p of HIDDEN) assert.equal(reserveLowVisible(p, LOW, "taz"), false, `${p} should hide it`);

  // THE EXHAUSTIVENESS PIN. Without it the two lists above are just examples, and a new phase
  // would inherit whichever branch it happened to land in - which is exactly how the original
  // gate acquired five states nobody had thought about.
  const ALL: Phase[] = ["checking", "syncing", "fault", "queued", "empty", "degraded", "ready", "submitting", "success", "cooldown", "error"];
  assert.deepEqual([...SHOWN, ...HIDDEN].sort(), [...ALL].sort(), "a Phase was added and this table was not updated");
});

test("hidden where the copy would be a lie, and the reason differs per phase", () => {
  // "Claims still work" is a promise. These are the three shapes that make it false.
  assert.equal(reserveLowVisible("fault", LOW, "taz"), false, "cannot send, so claims do NOT still work");
  assert.equal(reserveLowVisible("empty", LOW, "taz"), false, "empty is worse than low and the card already says it");
  assert.equal(reserveLowVisible("degraded", LOW, "taz"), false, "sends degraded, so it is not ours to promise");
});

test("it is the reconciler's decision, not our arithmetic on its numbers", () => {
  assert.equal(reserveLowVisible("ready", { spendableTaz: 4504, lowTaz: 5000, refilling: false }, "taz"), false,
    "spendable under the low mark is NOT the trigger - refilling is");
  assert.equal(reserveLowVisible("ready", { spendableTaz: 9999, lowTaz: 5000, refilling: true }, "taz"), true,
    "and refilling shows it even when the figures look healthy");
});

test("absent, null and empty reserve blocks hide it rather than throwing", () => {
  assert.equal(reserveLowVisible("ready", null, "taz"), false);
  assert.equal(reserveLowVisible("ready", undefined, "taz"), false);
  assert.equal(reserveLowVisible("ready", {}, "taz"), false);
});

test("TAZ only - this is a testnet float and the notice says TAZ", () => {
  assert.equal(reserveLowVisible("ready", LOW, "ctaz"), false);
});
