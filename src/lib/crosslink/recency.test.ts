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
  assert.equal(canServeCtaz(r.state), true);
  assert.equal(r.height, 372_104);
  assert.equal(r.roundLag, 1);
  assert.equal(r.finalizers, 2);
});

test("READY IS THE ONLY STATE THAT SERVES", () => {
  for (const s of ["behind", "stale", "not-activated", "cannot-verify"] as const) {
    assert.equal(canServeCtaz(s), false, `${s} must not hand out cTAZ`);
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
  assert.equal(canServeCtaz(r.state), false);
});

test("TFL being off is its own answer, distinct from an unreadable one", () => {
  const off = notActivated();
  assert.equal(off.state, "not-activated");
  assert.notEqual(off.state, readingFor(null, NOW).state);
  assert.equal(canServeCtaz(off.state), false);
});
