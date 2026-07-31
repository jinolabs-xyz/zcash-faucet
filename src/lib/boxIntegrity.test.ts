/**
 * The state that matters is `unknown`, because that is the state the box was
 * ACTUALLY in for the whole week while every other signal read healthy. Every test
 * here is written so it fails against "no report means fine".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntegrity, isIntegrityFailing, STALE_AFTER_MS } from "./boxIntegrity.ts";

const NOW = 1_700_000_000_000;
const rep = (o: Partial<{ expected: number; present: number; notEnabled: number; agoMs: number; readable: boolean }> = {}) => ({
  expected: o.expected ?? 25,
  present: o.present ?? 25,
  notEnabled: o.notEnabled ?? 0,
  at: NOW - (o.agoMs ?? 60_000),
  readable: o.readable ?? true,
});

test("a complete box passes the gate", () => {
  const s = classifyIntegrity(rep(), NOW);
  assert.equal(s.state, "complete");
  assert.equal(isIntegrityFailing(s), false);
});

test("THE ACTUAL 2026-07-31 STATE: nine of fourteen scripts missing", () => {
  const s = classifyIntegrity(rep({ expected: 14, present: 5 }), NOW);
  assert.equal(s.state, "incomplete");
  assert.equal(s.missing, 9);
  assert.equal(isIntegrityFailing(s), true);
  assert.match(s.reason, /9 of 14/);
});

test("NO REPORT FAILS THE GATE, which is the whole point", () => {
  // The box published nothing all week and every signal read healthy. If this ever
  // returns complete or stops failing, we have rebuilt the bug.
  const s = classifyIntegrity(null, NOW);
  assert.equal(s.state, "unknown");
  assert.equal(isIntegrityFailing(s), true, "silence must fail the gate, not pass it");
  assert.match(s.reason, /unverified/);
});

test("an unreadable report is unknown, not complete", () => {
  const s = classifyIntegrity(rep({ readable: false }), NOW);
  assert.equal(s.state, "unknown");
  assert.equal(isIntegrityFailing(s), true);
});

test("a stale report stops describing now, and fails", () => {
  const s = classifyIntegrity(rep({ agoMs: STALE_AFTER_MS + 60_000 }), NOW);
  assert.equal(s.state, "unknown");
  assert.equal(isIntegrityFailing(s), true);
  assert.match(s.reason, /no longer describes now/);
});

test("installed but NOT ENABLED is a failure on its own", () => {
  // Worse than missing: it works until the next reboot and then silently does not.
  const s = classifyIntegrity(rep({ notEnabled: 2 }), NOW);
  assert.equal(s.state, "incomplete");
  assert.equal(s.missing, 0);
  assert.equal(isIntegrityFailing(s), true);
  assert.match(s.reason, /not enabled/);
});

test("the endpoint carries no file names, only counts", () => {
  // /api/status is public. Naming the files missing from a production box is
  // reconnaissance, so the verdict must be numeric.
  const s = classifyIntegrity(rep({ expected: 14, present: 5 }), NOW);
  assert.doesNotMatch(s.reason, /\.sh|\.service|\.timer|\//);
});

test("present exceeding expected cannot fake a negative missing count", () => {
  const s = classifyIntegrity(rep({ expected: 5, present: 9 }), NOW);
  assert.equal(s.missing, 0);
  assert.equal(s.state, "complete");
});
