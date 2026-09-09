/**
 * The four miner states, and the first test is the outage that caused this file.
 *
 * The property under test throughout: no bad state may read as a good one, and
 * "we could not tell" must never collapse into either "running" or "off".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readingFor, isActive, type Heartbeat } from "./heartbeat.ts";

const NOW = Date.parse("2026-07-31T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const HEALTHY: Heartbeat = {
  schema: 1,
  writtenAt: ago(2),
  staleAfterSeconds: 30,
  templateStaleAfterSeconds: 360,
  mode: "submit",
  lastTemplateAt: ago(20),
  lastTemplateHeight: 4_221_033,
  lastErrorStage: null,
  lastErrorAt: null,
  consecutiveErrors: 0,
  solvedCount: 0,
  submittedAccepted: 0,
  submittedRejected: 0,
  lastSolvedAt: null,
  nodeLag: 0,
  waitingSince: null,
  waitingReason: null,
};

test("TODAY'S OUTAGE: beating every 5s while no template has arrived in 70 minutes", () => {
  // The exact shape that read "miner on" for 70 minutes. The process is alive and the
  // file is fresh, so anything keying off liveness calls this healthy. Only the
  // divergence between the two timestamps catches it.
  const r = readingFor({ ...HEALTHY, writtenAt: ago(2), lastTemplateAt: ago(70 * 60) }, NOW);
  assert.equal(r.state, "stalled");
  assert.equal(isActive(r.state), false, "this is the bug: it reported active for 70 minutes");
});

test("running, and it is the only state that is active", () => {
  const r = readingFor(HEALTHY, NOW);
  assert.equal(r.state, "running");
  assert.equal(isActive(r.state), true);
  assert.equal(r.lastTemplateHeight, 4_221_033);
  assert.equal(r.mode, "submit");
});

test("no file at all is CANNOT-VERIFY, never off", () => {
  // The distinction the env flag could not make. A missing heartbeat means we learned
  // nothing, and saying "off" would be asserting a fact we do not have.
  for (const raw of [null, undefined, "", 0, false, "not json"]) {
    const r = readingFor(raw, NOW);
    assert.equal(r.state, "cannot-verify", `${JSON.stringify(raw)} should not be classifiable`);
    assert.equal(isActive(r.state), false);
  }
});

test("a schema we do not know is cannot-verify, not a best-effort parse", () => {
  for (const schema of [0, 2, 99, "1", null, undefined]) {
    assert.equal(readingFor({ ...HEALTHY, schema }, NOW).state, "cannot-verify", `schema ${schema}`);
  }
});

test("the writer stopped: fresh-enough fields but nobody is updating the file", () => {
  const r = readingFor({ ...HEALTHY, writtenAt: ago(31), lastTemplateAt: ago(5) }, NOW);
  assert.equal(r.state, "not-writing");
});

test("not-writing outranks stalled, because a stale file cannot testify about itself", () => {
  // Both thresholds blown. If this reported "stalled" it would be quoting a template
  // age out of a file nobody has updated in an hour, which is reading a claim as a
  // measurement.
  const r = readingFor({ ...HEALTHY, writtenAt: ago(3600), lastTemplateAt: ago(3600) }, NOW);
  assert.equal(r.state, "not-writing");
});

test("a miner that has NEVER fetched a template is stalled, not running", () => {
  // lastTemplateAt null is not "running with no data yet". It has never done the one
  // thing it exists to do.
  const r = readingFor({ ...HEALTHY, lastTemplateAt: null, lastTemplateHeight: null }, NOW);
  assert.equal(r.state, "stalled");
  assert.equal(r.templateAgoSeconds, null, "null age must not become 0");
});

test("thresholds come from the file, so retuning the miner moves them", () => {
  // Same 45s-old template. Stale under a 30s threshold, fine under a 600s one. If this
  // reader hardcoded a multiplier, one of these would be wrong.
  const at = ago(45);
  assert.equal(readingFor({ ...HEALTHY, lastTemplateAt: at, templateStaleAfterSeconds: 30 }, NOW).state, "stalled");
  assert.equal(readingFor({ ...HEALTHY, lastTemplateAt: at, templateStaleAfterSeconds: 600 }, NOW).state, "running");
});

test("a missing or nonsense threshold is cannot-verify, not a default", () => {
  // Substituting our own number here would resurrect exactly the reader/writer
  // disagreement the published thresholds exist to prevent.
  for (const bad of [undefined, null, 0, -5, "30", NaN, Infinity]) {
    assert.equal(readingFor({ ...HEALTHY, staleAfterSeconds: bad }, NOW).state, "cannot-verify", `stale ${bad}`);
    assert.equal(readingFor({ ...HEALTHY, templateStaleAfterSeconds: bad }, NOW).state, "cannot-verify", `tmpl ${bad}`);
  }
});

test("a timestamp in the FUTURE is cannot-verify, never fresh", () => {
  // A negative age passes every staleness test. A broken clock must not be able to
  // make a dead miner look alive.
  const future = new Date(NOW + 60_000).toISOString();
  assert.equal(readingFor({ ...HEALTHY, writtenAt: future }, NOW).state, "cannot-verify");
  // Same rule one level down: a future template stamp is unreadable, so stalled.
  assert.equal(readingFor({ ...HEALTHY, lastTemplateAt: future }, NOW).state, "stalled");
});

test("an unparseable timestamp does not become age zero", () => {
  for (const bad of ["", "yesterday", "2026-13-45T99:99:99Z", 12345, null]) {
    assert.equal(readingFor({ ...HEALTHY, writtenAt: bad }, NOW).state, "cannot-verify", `writtenAt ${bad}`);
  }
});

test("exactly at a threshold is not past it", () => {
  // Off by one here flips the panel on every boundary tick.
  assert.equal(readingFor({ ...HEALTHY, writtenAt: ago(30) }, NOW).state, "running");
  assert.equal(readingFor({ ...HEALTHY, lastTemplateAt: ago(360) }, NOW).state, "running");
  assert.equal(readingFor({ ...HEALTHY, writtenAt: ago(30.1) }, NOW).state, "not-writing");
});

test("proposal mode is carried through, because it changes what running means", () => {
  // A miner in proposal mode never submits, so "mining" alone would overstate it.
  assert.equal(readingFor({ ...HEALTHY, mode: "proposal" }, NOW).mode, "proposal");
  assert.equal(readingFor({ ...HEALTHY, mode: "whatever" }, NOW).mode, null, "an unknown mode is not asserted");
});

test("errors are reported but do NOT decide the state", () => {
  // The state comes from the timestamps. A counter can read zero while nothing works,
  // which is the whole reason we stopped trusting a single field.
  const r = readingFor({ ...HEALTHY, lastErrorStage: "getblocktemplate", consecutiveErrors: 840 }, NOW);
  assert.equal(r.state, "running", "a fresh template means it is running, whatever the counter says");
  assert.equal(r.lastErrorStage, "getblocktemplate");
  assert.equal(r.consecutiveErrors, 840);
});

test("no state other than running is ever active", () => {
  for (const s of ["stalled", "not-writing", "cannot-verify"] as const) {
    assert.equal(isActive(s), false, `${s} must not read as active`);
  }
});

// ── THE SYNC GUARD: a miner idle on purpose is WAITING, not stalled ─────────────────────
// Before 2026-09-08 the miner mined whatever its node served, and spent an afternoon
// extending a private fork. Now it checks getblockchaininfo first and holds back when the
// node is behind; the heartbeat says so, and the reader must not call that a stall.

test("waitingSince set, file fresh: WAITING, even though no template has arrived in ages", () => {
  const r = readingFor({ ...HEALTHY, writtenAt: ago(2), lastTemplateAt: ago(3 * 3600), waitingSince: ago(90 * 60), nodeLag: 1443 }, NOW);
  assert.equal(r.state, "waiting");
  assert.equal(r.nodeLag, 1443);
  assert.equal(r.waitingAgoSeconds, 90 * 60);
  assert.equal(isActive(r.state), false, "waiting is never active: nothing is being mined");
});

test("not-writing still outranks waiting, because a stale file cannot testify to a choice either", () => {
  const r = readingFor({ ...HEALTHY, writtenAt: ago(600), waitingSince: ago(60), nodeLag: 80 }, NOW);
  assert.equal(r.state, "not-writing");
});

test("a writer that predates the guard carries no lag and no wait, and classifies as before", () => {
  const old: Record<string, unknown> = { ...HEALTHY };
  delete old.nodeLag;
  delete old.waitingSince;
  const r = readingFor(old, NOW);
  assert.equal(r.state, "running");
  assert.equal(r.nodeLag, null);
  assert.equal(r.waitingAgoSeconds, null);
});

test("waitingSince null with a fresh template is plain running, and the lag rides along", () => {
  const r = readingFor({ ...HEALTHY, waitingSince: null, nodeLag: 3 }, NOW);
  assert.equal(r.state, "running");
  assert.equal(r.nodeLag, 3);
});

test("a nonsense nodeLag is null, not a number the row would print", () => {
  for (const bad of [-1, "50", Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.equal(readingFor({ ...HEALTHY, nodeLag: bad as never }, NOW).nodeLag, null, `nodeLag ${String(bad)}`);
  }
});

test("a waitingSince in the future is not a wait, it is an unreadable stamp", () => {
  const r = readingFor({ ...HEALTHY, waitingSince: ago(-30) }, NOW);
  assert.equal(r.state, "running");
  assert.equal(r.waitingAgoSeconds, null);
});

test("a wait beside a non-zero error count is a STALL, the same verdict the watchdog reaches", () => {
  // The writer clears the wait on any error; an older writer might not. Both readers
  // must agree, or the panel says "waiting" while the watchdog restarts the miner.
  const r = readingFor({ ...HEALTHY, lastTemplateAt: ago(3600), waitingSince: ago(1800), consecutiveErrors: 4000, lastErrorStage: "getblockchaininfo" }, NOW);
  assert.equal(r.state, "stalled");
});

test("the reason rides along, and an empty or non-string reason is null", () => {
  assert.equal(readingFor({ ...HEALTHY, lastTemplateAt: ago(3600), waitingSince: ago(60), waitingReason: "no-peers" }, NOW).waitingReason, "no-peers");
  assert.equal(readingFor({ ...HEALTHY, waitingReason: "" }, NOW).waitingReason, null);
  assert.equal(readingFor({ ...HEALTHY, waitingReason: 7 as never }, NOW).waitingReason, null);
});

test("a wait with NO error count at all is not honoured either, matching the watchdog", () => {
  const { consecutiveErrors: _c, ...noCount } = { ...HEALTHY, lastTemplateAt: ago(3600), waitingSince: ago(1800) };
  void _c;
  assert.equal(readingFor(noCount, NOW).state, "stalled");
});
