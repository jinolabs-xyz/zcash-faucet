/**
 * The state that matters is `unknown`, because that is the state the box was
 * ACTUALLY in for the whole week while every other signal read healthy. Every test
 * here is written so it fails against "no report means fine".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntegrity, isIntegrityFailing, STALE_AFTER_MS } from "./boxIntegrity.ts";

const NOW = 1_700_000_000_000;
const rep = (o: Partial<{ expected: number; present: number; notEnabled: number; enabledUndeclared: number | null; watchdogRestarts: number | null; watchdogRestartsDelta: number | null; platform: string | null; minerBinary: string | null; minerUnit: string | null; watchdogUnit: string | null; alertBridge: string | null; agoMs: number; readable: boolean }> = {}) => ({
  expected: o.expected ?? 25,
  present: o.present ?? 25,
  notEnabled: o.notEnabled ?? 0,
  enabledUndeclared: o.enabledUndeclared ?? null,
  watchdogRestarts: o.watchdogRestarts ?? null,
  watchdogRestartsDelta: o.watchdogRestartsDelta ?? null,
  platform: o.platform ?? null,
  minerBinary: o.minerBinary ?? null,
  minerUnit: o.minerUnit ?? null,
  watchdogUnit: o.watchdogUnit ?? null,
  alertBridge: o.alertBridge ?? null,
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

test("enabledUndeclared passes through untouched, and never shapes the verdict", () => {
  // #339: the box wrote this field and the app silently dropped it, so the
  // declaration file's oldest promise was recorded on the box and invisible
  // everywhere else. Drift is a fact to surface, not a fault to classify on.
  const withDrift = classifyIntegrity(rep({ enabledUndeclared: 2 }), NOW);
  assert.equal(withDrift.state, "complete", "drift alone must not fail the gate");
  assert.equal(withDrift.enabledUndeclared, 2);

  // A pre-#338 report has no field at all: unmeasured is not zero.
  const preField = classifyIntegrity(rep({}), NOW);
  assert.equal(preField.enabledUndeclared, null);

  // Drift rides along on a failing report too, rather than being dropped there.
  const failing = classifyIntegrity(rep({ notEnabled: 1, enabledUndeclared: 2 }), NOW);
  assert.equal(failing.state, "incomplete");
  assert.equal(failing.enabledUndeclared, 2);
});

test("alertBridge rides through classification untouched, complete or not", () => {
  assert.equal(classifyIntegrity(rep({ alertBridge: "down" }), NOW).alertBridge, "down");
  assert.equal(classifyIntegrity(rep({ present: 1, alertBridge: "ok" }), NOW).alertBridge, "ok");
  assert.equal(classifyIntegrity(null, NOW).alertBridge, null);
});

// ---- THE DRIFT AUDIT'S OWN VERDICT (#721's follow-up): every word reachable, pure -------------
import { classifyDrift, DRIFT_STALE_AFTER_MS, type DriftReport } from "./boxIntegrity.ts";

const counts = (rc: number, findings = 0, unverified = 0) => ({ rc, findings, unverified });
const fresh = (over: Partial<DriftReport> = {}): DriftReport => ({
  at: NOW - 5 * 60_000,
  repoSha: "0123456789abcdef0123456789abcdef01234567",
  config: counts(0),
  access: counts(0),
  ...over,
});

test("drift: a report older than the field is unknown, and says so", () => {
  const d = classifyDrift(undefined, NOW);
  assert.equal(d.state, "unknown");
  assert.match(d.reason, /predates the drift field/);
  assert.equal(d.findings, null);
});

test("drift: a box that published nothing is unknown, not clean", () => {
  const d = classifyDrift(null, NOW);
  assert.equal(d.state, "unknown");
  assert.match(d.reason, /not published/);
});

test("drift: clean is affirmative - both audits ran, nothing found, nothing skipped", () => {
  const d = classifyDrift(fresh(), NOW);
  assert.equal(d.state, "clean");
  assert.equal(d.findings, 0);
  assert.equal(d.unverified, 0);
  assert.equal(d.ageSeconds, 300);
  assert.equal(d.repoSha, "0123456789abcdef0123456789abcdef01234567");
});

test("drift: findings in EITHER audit read as drift, summed", () => {
  const d = classifyDrift(fresh({ config: counts(1, 3), access: counts(1, 2) }), NOW);
  assert.equal(d.state, "drift");
  assert.equal(d.findings, 5);
  assert.match(d.reason, /5 finding/);
});

test("drift: a check that could not run is incomplete even with zero findings", () => {
  const d = classifyDrift(fresh({ config: counts(2, 0, 2) }), NOW);
  assert.equal(d.state, "incomplete");
  assert.equal(d.unverified, 2);
  assert.match(d.reason, /2 check\(s\) could not run/);
});

test("drift: an audit that could not run at all (rc 3) is incomplete, and its zeros are not clean", () => {
  const d = classifyDrift(fresh({ access: counts(3, 0, 0) }), NOW);
  assert.equal(d.state, "incomplete");
  assert.match(d.reason, /could not run on the box/);
});

test("drift: findings outrank incomplete when both are true", () => {
  const d = classifyDrift(fresh({ config: counts(2, 1, 1) }), NOW);
  assert.equal(d.state, "drift");
});

test("drift: past the bound the word is STALE whatever the counts said - silence is not yesterday's clean", () => {
  const d = classifyDrift(fresh({ at: NOW - DRIFT_STALE_AFTER_MS - 1000 }), NOW);
  assert.equal(d.state, "stale");
  assert.match(d.reason, /stopped arriving/);
  assert.equal(d.findings, 0, "the counts are still carried, so an operator sees what the last run said");
});

test("drift: exactly at the bound is still fresh; one second past is not", () => {
  assert.equal(classifyDrift(fresh({ at: NOW - DRIFT_STALE_AFTER_MS }), NOW).state, "clean");
  assert.equal(classifyDrift(fresh({ at: NOW - DRIFT_STALE_AFTER_MS - 1 }), NOW).state, "stale");
});

test("drift: the bound is 90 minutes - three missed half-hour runs, not a day", () => {
  assert.equal(DRIFT_STALE_AFTER_MS, 90 * 60_000);
});

test("drift: the verdict rides on classifyIntegrity whatever the box's own state, because the two clocks are independent", () => {
  const stale = classifyIntegrity({ ...rep({ agoMs: 60 * 60_000 }), drift: fresh({ config: counts(1, 2) }) }, NOW);
  assert.equal(stale.state, "unknown", "the box report itself is stale");
  assert.equal(stale.drift.state, "drift", "and the drift verdict is still read from what it carried");
  const none = classifyIntegrity(null, NOW);
  assert.equal(none.drift.state, "unknown");
});

test("drift: rc 1 with a count of ZERO is still drift - the exit code outranks a grep that missed the word", () => {
  // The access audit prints FINDING, not DRIFT; a wrapper counting one word published rc 1 /
  // findings 0 and a count-first reader called it clean (App's block on #726).
  const d = classifyDrift(fresh({ access: counts(1, 0, 0) }), NOW);
  assert.equal(d.state, "drift");
  assert.match(d.reason, /reported but the wrapper did not count/);
});

test("drift: rc 0 with findings above zero is drift, never clean - a contradiction reads as the worse half", () => {
  const d = classifyDrift(fresh({ config: counts(0, 2, 0) }), NOW);
  assert.equal(d.state, "drift");
  assert.equal(d.findings, 2);
});
