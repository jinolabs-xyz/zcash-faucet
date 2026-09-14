/**
 * The box verdict, and the one word the public page gets from it.
 *
 * The bug behind the original file was a missing sentence: #287 measured the verdict,
 * put it on /api/status, and never rendered it. The bug behind this version is the
 * opposite one (risk register II, R-24): the sentences were so good that the public
 * strip read "WATCHDOG STOPPED, nothing heals" and "CANNOT PAGE" to anyone who looked.
 * So the verdicts are pinned here on the predicates, and the public words are pinned
 * to never name a fault.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertBridgeDown,
  boxIsBad,
  publicBox,
  publicBoxChip,
  publicBoxIsBad,
  publicBoxRow,
  watchdogLooping,
  watchdogStopped,
} from "./boxLabel.ts";
import { classifyIntegrity } from "./boxIntegrity.ts";

const NOW = Date.parse("2026-07-31T12:00:00Z");
// The baseline is a box that has AFFIRMED both halves: watchdog active, pager probed
// ok. A null in either field is a server too old to say, and reads unknown below.
const report = (over = {}) => ({ expected: 14, present: 14, notEnabled: 0, enabledUndeclared: null, watchdogRestarts: null, watchdogRestartsDelta: null, platform: null, minerBinary: null, minerUnit: null, watchdogUnit: "active", alertBridge: "ok", at: NOW - 30_000, readable: true, ...over });
const pub = (over = {}) => publicBox(classifyIntegrity(report(over), NOW));

// ── THE PUBLIC WORDS NAME NO FAULT ─────────────────────────────────────────────────────

test("a complete box is ok, earns no strip chip, and is not flagged", () => {
  const b = pub();
  assert.equal(b.state, "ok");
  assert.equal(publicBoxChip(b), null, "a permanent 'box ok' would spend the strip's slot on what an operator assumes");
  assert.equal(publicBoxIsBad(b), false);
  assert.match(publicBoxRow(b), /^ok/);
});

test("EVERY FAULT IS ONE WORD ON THE PUBLIC PAGE: attention, never which fault", () => {
  // Each of these used to render its own sentence on a public page. A stopped watchdog
  // and a pager that reaches nobody are exactly what an attacker wants to know the
  // timing of; a visitor needs to know only that the operators have something to look at.
  const faults = [
    { present: 12, notEnabled: 1 },
    { present: 13 },
    { notEnabled: 2 },
    { watchdogRestarts: 412, watchdogRestartsDelta: 61 },
    { watchdogUnit: "inactive" },
    { watchdogUnit: "failed" },
    { watchdogUnit: "deactivating" },
    { alertBridge: "down" },
    { alertBridge: "unlinked" },
    { alertBridge: "none" },
    { alertBridge: "misconfigured" },
    { present: 13, alertBridge: "none" },
    { watchdogUnit: "inactive", alertBridge: "down", watchdogRestartsDelta: 61 },
  ];
  for (const over of faults) {
    const b = pub(over);
    const tag = JSON.stringify(over);
    assert.equal(b.state, "attention", tag);
    assert.equal(publicBoxChip(b), "OPS ATTENTION", tag);
    assert.equal(publicBoxIsBad(b), true, tag);
    const words = `${publicBoxChip(b)} ${publicBoxRow(b)}`;
    assert.doesNotMatch(words, /WATCHDOG|PAGE|BRIDGE|ALERT|MISSING|ENABLED|heal|nowhere|\d/, `${tag}: ${words}`);
  }
});

test("OK IS AFFIRMATIVE: a watchdog or pager the box could not read is unknown, never ok", () => {
  // Review of #543. watchdogUnit "unknown" and alertBridge "unknown" are deliberately
  // not faults (the detail-bearing predicates leave them to the probe), so the first cut
  // read them as ok and a tokenless probe affirmed "the box can page someone" from a
  // word that said the box could not tell. Every combination that is not both affirmed
  // is unknown; only active/activating plus ok/webhook is ok.
  for (const over of [
    { watchdogUnit: "unknown" },
    { alertBridge: "unknown" },
    { watchdogUnit: "unknown", alertBridge: "unknown" },
    { watchdogUnit: null },
    { alertBridge: null },
  ]) {
    const b = pub(over);
    assert.equal(b.state, "unknown", JSON.stringify(over));
    assert.equal(publicBoxIsBad(b), true, JSON.stringify(over));
  }
  for (const over of [{ watchdogUnit: "active", alertBridge: "ok" }, { watchdogUnit: "activating", alertBridge: "webhook" }]) {
    assert.equal(pub(over).state, "ok", JSON.stringify(over));
  }
});

test("no report, and a report too old, are unknown: not ok, not a named fault, and flagged", () => {
  // The off-box probe fails on unknown (a box that cannot say what it has is the box we
  // had all week); the page must not read it as fine either.
  for (const b of [publicBox(classifyIntegrity(null, NOW)), pub({ at: NOW - 3 * 3600_000 })]) {
    assert.equal(b.state, "unknown");
    assert.equal(publicBoxChip(b), "unknown");
    assert.equal(publicBoxIsBad(b), true);
    assert.match(publicBoxRow(b), /^unknown/);
    assert.doesNotMatch(publicBoxRow(b), /\d/, "no counts, no ages: the row says unknown and nothing more");
  }
});

test("the miner unit rides along, because the miner panel tells a parked miner from a dead one with it", () => {
  assert.equal(pub({ minerUnit: "inactive" }).minerUnit, "inactive");
  assert.equal(pub().minerUnit, null);
});

// ── THE VERDICTS THEMSELVES, on the predicates the route folds into that word ─────────

test("A WATCHDOG IN A RESTART LOOP IS A FAULT, even on a box with every file in place", () => {
  // A unit only reaches systemd's failed state if systemd gives up on it, and
  // faucet-watchdog is Restart=always with no start limit on purpose. So its own
  // OnFailure= alert can never fire, and the service whose job is noticing that other
  // things are broken was the one thing nothing watched.
  const s = classifyIntegrity(report({ watchdogRestarts: 412, watchdogRestartsDelta: 61 }), NOW);
  assert.equal(s.state, "complete", "every file is present, so the file verdict is clean");
  assert.equal(watchdogLooping(s), true);
  assert.equal(boxIsBad(s), true, "a looping supervisor is a fault, not a note");
});

test("THE DELTA DECIDES, NOT THE CUMULATIVE COUNT", () => {
  // NRestarts never resets. A box up for a month with a few restarts long ago and a box
  // looping right now print similar numbers, so classifying on the total would flag a
  // healthy box forever and teach an operator to ignore the flag.
  const old = classifyIntegrity(report({ watchdogRestarts: 412, watchdogRestartsDelta: 0 }), NOW);
  assert.equal(watchdogLooping(old), false);
  assert.equal(boxIsBad(old), false, "412 lifetime restarts with none recently is not a loop");
});

test("one restart between reports is a restart, not a loop", () => {
  const s = classifyIntegrity(report({ watchdogRestarts: 9, watchdogRestartsDelta: 1 }), NOW);
  assert.equal(watchdogLooping(s), false);
  assert.equal(boxIsBad(s), false);
});

test("an UNREAD counter is not a calm one and not a loop: nothing is claimed either way", () => {
  const s = classifyIntegrity(report({ watchdogRestarts: null, watchdogRestartsDelta: null }), NOW);
  assert.equal(watchdogLooping(s), false);
  assert.equal(boxIsBad(s), false, "unmeasured must not be reported as broken");
});

test("a dead, unlinked, absent or misconfigured alert channel is a fault: no alert about it can arrive", () => {
  for (const v of ["down", "unlinked", "none", "misconfigured"]) {
    const s = classifyIntegrity(report({ alertBridge: v }), NOW);
    assert.equal(alertBridgeDown(s), true, v);
    assert.equal(boxIsBad(s), true, v);
  }
});

test("ok, a webhook channel, unknown and an older report are NOT the pager fault", () => {
  // "unknown" is the off-box probe's to fail: a public row cannot separate "could not ask"
  // from "asked and it is down" without teaching readers to ignore red.
  for (const v of ["ok", "webhook", "unknown", null]) {
    const s = classifyIntegrity(report({ alertBridge: v }), NOW);
    assert.equal(alertBridgeDown(s), false, `alertBridge ${String(v)}`);
    assert.equal(boxIsBad(s), false, `alertBridge ${String(v)}`);
  }
});

test("a watchdog systemd calls inactive, failed or deactivating is a fault (risk register #16)", () => {
  // is-enabled was true of it, Restart=always never let it reach failed, and the restart
  // counter counted restarts, of which a stopped unit has none: a box with no
  // self-healing read complete and calm.
  for (const v of ["inactive", "failed", "deactivating"]) {
    const s = classifyIntegrity(report({ watchdogUnit: v }), NOW);
    assert.equal(s.state, "complete", "the files are all there; that is exactly the trap");
    assert.equal(watchdogStopped(s), true, v);
    assert.equal(boxIsBad(s), true, v);
  }
});

test("active, activating, unknown and an older report are not that fault", () => {
  // activating is seconds from running; unknown is the off-box probe's to fail; null is
  // a server that predates the field. deactivating is NOT here: its next state is
  // stopped, and passing it would reopen the hole at the moment a stop begins.
  for (const v of ["active", "activating", "unknown", null]) {
    const s = classifyIntegrity(report({ watchdogUnit: v }), NOW);
    assert.equal(watchdogStopped(s), false, `watchdogUnit ${String(v)}`);
    assert.equal(boxIsBad(s), false, `watchdogUnit ${String(v)}`);
  }
});

test("undeclared enabled units are a fact, not a fault: a drifted box is still ok", () => {
  // classifyIntegrity's own comment: drift is surfaced, never classified on. Folding it
  // into the verdict would make a drifted box outrank a clean one.
  const s = classifyIntegrity(report({ enabledUndeclared: 2 }), NOW);
  assert.equal(boxIsBad(s), false);
  assert.equal(publicBox(s).state, "ok");
});
