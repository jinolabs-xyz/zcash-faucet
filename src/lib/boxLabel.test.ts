/**
 * The box integrity wording.
 *
 * The bug behind this file is not a wrong sentence, it is a missing one: #287 measured
 * the verdict, put it on /api/status, and never rendered it. So the first test is that
 * a failing box produces something a person can read at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boxRow, boxChip, boxIsBad } from "./boxLabel.ts";
import { classifyIntegrity } from "./boxIntegrity.ts";

const NOW = Date.parse("2026-07-31T12:00:00Z");
const report = (over = {}) => ({ expected: 14, present: 14, notEnabled: 0, enabledUndeclared: null, at: NOW - 30_000, readable: true, ...over });

test("THE STATE NOTHING RENDERED: two files gone and a unit disabled says so", () => {
  const s = classifyIntegrity(report({ present: 12, notEnabled: 1 }), NOW);
  const row = boxRow(s);
  assert.match(row, /2 of 14 MISSING/);
  assert.match(row, /1 NOT ENABLED/);
  assert.equal(boxIsBad(s), true);
  assert.equal(boxChip(s), "INCOMPLETE");
});

test("a complete box says so plainly and is not flagged", () => {
  const s = classifyIntegrity(report(), NOW);
  assert.equal(boxRow(s), "14 of 14 files, all enabled");
  assert.equal(boxIsBad(s), false);
});

test("complete is the ONLY state with no strip chip", () => {
  // The strip is terse, so a permanent "box ok" would cost a slot to say what an
  // operator already assumes. Everything else has to be visible without a click.
  assert.equal(boxChip(classifyIntegrity(report(), NOW)), null);
  assert.notEqual(boxChip(classifyIntegrity(report({ present: 13 }), NOW)), null);
  assert.notEqual(boxChip(classifyIntegrity(null, NOW)), null);
});

test("no report is 'cannot tell', never 'complete' and never a proven fault", () => {
  const s = classifyIntegrity(null, NOW);
  assert.match(boxRow(s), /cannot tell/);
  assert.doesNotMatch(boxRow(s), /all enabled|MISSING/);
  assert.equal(boxIsBad(s), true, "unverified must fail, same as the external gate");
});

test("never-reported and reported-too-long-ago are different sentences", () => {
  // They call for different actions: a unit that was never installed, versus one
  // that has stopped. Collapsing them sends an operator to the wrong place.
  const never = boxRow(classifyIntegrity(null, NOW));
  const stale = boxRow(classifyIntegrity(report({ at: NOW - 3 * 3600_000 }), NOW));
  assert.match(never, /has not reported/);
  assert.match(stale, /last report \d+ min old/);
  assert.notEqual(never, stale);
});

test("missing alone and not-enabled alone each render on their own", () => {
  assert.match(boxRow(classifyIntegrity(report({ present: 11 }), NOW)), /3 of 14 MISSING/);
  const disabled = boxRow(classifyIntegrity(report({ notEnabled: 2 }), NOW));
  assert.match(disabled, /2 NOT ENABLED/);
  assert.doesNotMatch(disabled, /MISSING/, "nothing is missing, so do not say it is");
});

test("no file NAMES reach the panel, only counts", () => {
  // #287's constraint, and it has to hold at the screen rather than only at the API:
  // naming what a production box is missing is reconnaissance, and this is public.
  for (const s of [
    classifyIntegrity(report({ present: 12, notEnabled: 1 }), NOW),
    classifyIntegrity(report(), NOW),
    classifyIntegrity(null, NOW),
  ]) {
    assert.doesNotMatch(boxRow(s), /\.(sh|service|timer|json|ts|mjs)\b|\//, `path-shaped text in "${boxRow(s)}"`);
  }
});

test("every bad state is flagged, so none of them can render as ordinary", () => {
  assert.equal(boxIsBad(classifyIntegrity(report({ present: 13 }), NOW)), true);
  assert.equal(boxIsBad(classifyIntegrity(report({ notEnabled: 1 }), NOW)), true);
  assert.equal(boxIsBad(classifyIntegrity(report({ at: NOW - 3 * 3600_000 }), NOW)), true);
  assert.equal(boxIsBad(classifyIntegrity(null, NOW)), true);
});

/* ── Undeclared units, which the API has been sending and nothing rendered ──────── */

test("a clean box SAYS when units are enabled that the repo never declared", () => {
  // /api/status answers enabledUndeclared 2 and the panel row said "34 of 34 files,
  // all enabled". Three additions were needed to get it here: #338 wrote it on the
  // box, #341 passed it through to the API, this renders it. My commit claimed the API
  // had always sent it, which was a live probe of an already-fixed world mistaken for
  // history. See the corrected note in boxLabel.ts.
  const row = boxRow(classifyIntegrity(report({ expected: 34, present: 34, enabledUndeclared: 2 }), NOW));
  assert.match(row, /34 of 34 files, all enabled/, "the existing clause must survive");
  assert.match(row, /2 enabled but undeclared/);
});

test("and it is NOT a fault, so the chip and the marker stay quiet", () => {
  // classifyIntegrity's own comment: drift is a fact to surface, not a fault. The two
  // on production are faucet.service and the autodeploy timer, both meant to be there
  // and merely undeclared. Marking that red would train an operator to ignore red.
  const s = classifyIntegrity(report({ expected: 34, present: 34, enabledUndeclared: 2 }), NOW);
  assert.equal(boxIsBad(s), false, "drift must not turn the row red");
  assert.equal(boxChip(s), null, "and must not spend a slot on the terse strip");
});

test("zero and unknown both render nothing, and they are different facts", () => {
  // 0 is a box that reported no drift. null is a report too old to carry the field.
  // Neither earns a clause: "0 undeclared" is noise and "undeclared unknown" would
  // imply a problem where there is only an older deploy.
  assert.doesNotMatch(boxRow(classifyIntegrity(report({ expected: 9, present: 9, enabledUndeclared: 0 }), NOW)), /undeclared/);
  assert.doesNotMatch(boxRow(classifyIntegrity(report({ expected: 9, present: 9, enabledUndeclared: null }), NOW)), /undeclared/);
});

test("an INCOMPLETE box reports drift too, without it displacing the real fault", () => {
  // The fault has to lead. Drift is additional information, never a substitute for
  // "2 units are missing", and appending it must not push the count out of the row.
  const row = boxRow(classifyIntegrity(report({ expected: 34, present: 32, notEnabled: 1, enabledUndeclared: 3 }), NOW));
  assert.match(row, /2 of 34 MISSING/);
  assert.match(row, /1 NOT ENABLED/);
  assert.match(row, /3 enabled but undeclared/);
  assert.ok(row.indexOf("MISSING") < row.indexOf("undeclared"), "the fault must come first");
});

test("DRIFT IS NEVER FOLDED INTO THE COUNTS, or a drifted box outranks a clean one", () => {
  // The entry this helper exists to avoid. If undeclared units were added to
  // `present`, a box with 32 of 34 files and 2 stray units would render as 34 of 34.
  const drifted = boxRow(classifyIntegrity(report({ expected: 34, present: 32, notEnabled: 0, enabledUndeclared: 2 }), NOW));
  assert.doesNotMatch(drifted, /34 of 34/, "an extra enabled unit is not a present file");
});
