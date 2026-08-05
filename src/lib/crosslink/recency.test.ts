/**
 * The cTAZ readiness gate. Every case is a state the faucet could be in while someone is
 * waiting for a drip, and the rule throughout: only `ready` may serve, and "we could not
 * tell" must never be one of the states that can.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readingFor, canServeCtaz, notActivated, MAX_AGE_SECONDS, MAX_ROUND_LAG } from "./recency.ts";

const NOW = Date.parse("2026-08-02T12:00:00Z");
const at = (secondsAgo: number) => Math.floor(NOW / 1000) - secondsAgo;

const HEALTHY = {
  now_utc: at(2),
  my_height: 372_104,
  my_round: 41,
  my_locked_round: 40,
  finalizer_statuses: [{ pub_key: "aa", voting_power: 1 }, { pub_key: "bb", voting_power: 1 }],
};

test("a node keeping up with its own finality view is ready", () => {
  const r = readingFor(HEALTHY, NOW);
  assert.equal(r.state, "ready");
  assert.equal(canServeCtaz(r.state, 100, 100, "rpc"), true);
  assert.equal(r.height, 372_104);
  assert.equal(r.roundLag, 1);
  assert.equal(r.finalizers, 2);
});

test("READY IS THE ONLY STATE THAT SERVES", () => {
  for (const s of ["behind", "stale", "not-activated", "cannot-verify"] as const) {
    assert.equal(canServeCtaz(s, 100, 100, "rpc"), false, `${s} must not hand out cTAZ`);
  }
});

test("no answer at all is cannot-verify, never a verdict about the chain", () => {
  for (const raw of [null, undefined, "", 0, false, "not json", []]) {
    const r = readingFor(raw, NOW);
    assert.equal(r.state, "cannot-verify", `${JSON.stringify(raw)} should not be classifiable`);
    assert.equal(r.height, null, "a height we do not have must not become 0");
  }
});

test("a partial reply is cannot-verify rather than a best-effort read", () => {
  for (const drop of ["now_utc", "my_height", "my_round", "my_locked_round"]) {
    const partial: Record<string, unknown> = { ...HEALTHY };
    delete partial[drop];
    assert.equal(readingFor(partial, NOW).state, "cannot-verify", `missing ${drop}`);
  }
});

test("a stale answer is stale, and staleness outranks the rounds inside it", () => {
  // Both wrong at once. If this reported "behind" it would be quoting a round lag out of
  // a reply too old to describe now, which is reading a claim as a measurement.
  const r = readingFor({ ...HEALTHY, now_utc: at(MAX_AGE_SECONDS + 1), my_round: 99, my_locked_round: 40 }, NOW);
  assert.equal(r.state, "stale");
});

test("exactly at the age limit is not past it", () => {
  assert.equal(readingFor({ ...HEALTHY, now_utc: at(MAX_AGE_SECONDS) }, NOW).state, "ready");
  assert.equal(readingFor({ ...HEALTHY, now_utc: at(MAX_AGE_SECONDS + 1) }, NOW).state, "stale");
});

test("a reply from the FUTURE is cannot-verify, never fresh", () => {
  // Their node and ours are different machines. A negative age passes every staleness
  // test, so a clock skew must not be able to make a wedged node look current.
  assert.equal(readingFor({ ...HEALTHY, now_utc: at(-60) }, NOW).state, "cannot-verify");
});

test("trailing the locked round by more than the budget is BEHIND", () => {
  assert.equal(readingFor({ ...HEALTHY, my_round: 40 + MAX_ROUND_LAG, my_locked_round: 40 }, NOW).state, "ready");
  assert.equal(readingFor({ ...HEALTHY, my_round: 40 + MAX_ROUND_LAG + 1, my_locked_round: 40 }, NOW).state, "behind");
});

test("a lag budget of zero would flap, so the budget is not zero", () => {
  // A round transition is normal traffic, not a fault. Gating on equality would take the
  // faucet down every time the chain advanced.
  assert.ok(MAX_ROUND_LAG >= 1, "a zero budget flaps on every normal round transition");
  assert.equal(readingFor({ ...HEALTHY, my_round: 41, my_locked_round: 40 }, NOW).state, "ready");
});

test("locked ahead of seen is unexplained, so cannot-verify rather than behind", () => {
  // Their node should not report this. Calling it "behind" would be inventing a
  // diagnosis for a shape we do not understand.
  const r = readingFor({ ...HEALTHY, my_round: 40, my_locked_round: 41 }, NOW);
  assert.equal(r.state, "cannot-verify");
  assert.equal(r.roundLag, null, "a lag we cannot interpret must not be reported as a number");
});

test("no finalizers means no finality view, whatever the rounds say", () => {
  const r = readingFor({ ...HEALTHY, finalizer_statuses: [] }, NOW);
  assert.equal(r.state, "not-activated");
  assert.equal(canServeCtaz(r.state, 100, 100, "rpc"), false);
});

test("TFL being off is its own answer, distinct from an unreadable one", () => {
  const off = notActivated();
  assert.equal(off.state, "not-activated");
  assert.notEqual(off.state, readingFor(null, NOW).state);
  assert.equal(canServeCtaz(off.state, 100, 100, "rpc"), false);
});

/* ── The gate asks TWO questions now (#322) ──────────────────────────────────────── */

test("A NODE WITH CURRENT ROUNDS AND A QUARTER OF THE CHAIN DOES NOT SERVE", () => {
  // The defect this closes, and it was live: the five states describe the FINALITY view,
  // so a node can report fresh rounds while being nowhere near tip. My own #322 test row
  // read READY at 23.1% synced. Their wallet needs the chain to spend, so serving from it
  // would accept a claim and fail to pay, and that reads as a faucet bug rather than as a
  // gate that never asked. Hard block on #328 per the CTO.
  assert.equal(canServeCtaz("ready", 83_633, 362_000, "rpc"), false);
});

test("and a synced node with current rounds does serve, or the gate is just off", () => {
  // The control. Without this, refusing everything would pass the test above.
  assert.equal(canServeCtaz("ready", 293_300, 293_300, "rpc"), true);
});

test("the lag budget is small but not zero, because a tip estimate lags by a block", () => {
  assert.equal(canServeCtaz("ready", 293_298, 293_300, "rpc"), true, "two blocks is propagation");
  assert.equal(canServeCtaz("ready", 293_290, 293_300, "rpc"), false, "ten is not caught up");
  // A node AHEAD of the reported tip is not behind. The tip is an estimate.
  assert.equal(canServeCtaz("ready", 293_305, 293_300, "rpc"), true);
});

test("AN UNREADABLE HEIGHT REFUSES, exactly as cannot-verify does", () => {
  // Fails closed. An unmeasured sync distance is not a short one, and defaulting either
  // side to zero would make an unreadable node look perfectly caught up.
  assert.equal(canServeCtaz("ready", null, 293_300, "rpc"), false);
  assert.equal(canServeCtaz("ready", 293_300, null, "rpc"), false);
  assert.equal(canServeCtaz("ready", null, null, "rpc"), false);
});

test("a bad state still refuses however well synced the node is", () => {
  // Sync completeness is an ADDITIONAL requirement, never a substitute for the verdict.
  for (const s of ["behind", "stale", "not-activated", "cannot-verify"] as const) {
    assert.equal(canServeCtaz(s, 293_300, 293_300, "rpc"), false, `${s} must not serve`);
  }
});

// ── THE THIRD QUESTION: CAN THE PAYER REACH THE NODE? (#409) ─────────────────────────
//
// Production answered the first two questions perfectly and still could not pay. The
// panel showed ready and servable, and every cTAZ claim died at `fetch("")` because the
// faucet container has no route to the node's RPC - which read.ts's own header had said
// all along, while building a file fallback so READING would work. Nobody asked what
// PAYING would do.
//
// These fail against the two-argument gate. That is the only reason to trust them.

test("a node known ONLY through the status file cannot be served from", () => {
  // The file proves the node is well. It proves nothing about our route to it, and the
  // payment is an RPC call. This is the production case exactly: a healthy node, a fresh
  // file, and no way to spend from either.
  assert.equal(canServeCtaz("ready", 294_800, 294_801, "file"), false);
});

test("and the same reading over RPC IS servable, so this is not just a blanket refusal", () => {
  // The mirror. Without it, the test above would pass against a gate that had simply been
  // wired to false, and cTAZ would be dark forever with a green suite.
  assert.equal(canServeCtaz("ready", 294_800, 294_801, "rpc"), true);
});

test("no source at all refuses, like every other unknown here", () => {
  assert.equal(canServeCtaz("ready", 294_800, 294_801, "none"), false);
});

test("reachability does not excuse a node that is behind or not final", () => {
  // The third question is an AND, not an OR. A reachable node still has to be current.
  assert.equal(canServeCtaz("ready", 294_000, 294_801, "rpc"), false);
  assert.equal(canServeCtaz("cannot-verify", 294_800, 294_801, "rpc"), false);
});

test("THE GATE FLIPS ON ITS OWN when the transport lands, with no config to remember", () => {
  // Why `source` rather than "is CROSSLINK_RPC_URL set". Checking configuration would turn
  // this true the moment someone exported the variable, whether or not a route existed -
  // the same trap one level down. Reaching the node over RPC is the thing that cannot be
  // faked by setting a string, so the day the transport exists this starts serving without
  // anyone having to notice a second switch.
  const behindTheFile = canServeCtaz("ready", 294_800, 294_801, "file");
  const overTheWire = canServeCtaz("ready", 294_800, 294_801, "rpc");
  assert.equal(behindTheFile, false);
  assert.equal(overTheWire, true);
});
