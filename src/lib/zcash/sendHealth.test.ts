/**
 * The money path's own health, and the two ways counting it could do harm.
 *
 * Over-counting pages on noise and, through the watchdog, hands a blip the power to
 * roll back a good deploy. Under-counting is the bug this exists to close. Both
 * directions are asserted, because a guard that cannot fire is the same as no guard and
 * looks identical in a green run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readSendHealth,
  sendHealthBlocksServing,
  recordSend,
  resetSendHealth,
  WINDOW_MS,
  MIN_SAMPLE,
  FAIL_RATIO,
  type SendRecord,
} from "./sendHealth.ts";

const NOW = 1_800_000_000_000;
const at = (outcome: "ok" | "failed" | "unknown", agoMs = 0): SendRecord => ({ outcome, at: NOW - agoMs });
const many = (outcome: "ok" | "failed" | "unknown", n: number) => Array.from({ length: n }, () => at(outcome));

test("THE CASE THIS EXISTS FOR: every send failing while a balance still reads", () => {
  // A crash-looping wallet is alive often enough for /api/ready's balance probe to
  // land, so readiness says 200 while every claim 502s. Nothing else in the app can
  // see that, because a failed send is a log line nobody aggregates.
  const h = readSendHealth(NOW, many("failed", 4));
  assert.equal(h.state, "degraded");
  assert.equal(sendHealthBlocksServing(h), true);
  assert.match(h.reason, /4 of the last 4 sends failed/);
});

test("a healthy run says so, so the signal is not permanently alarmed", () => {
  const h = readSendHealth(NOW, many("ok", 5));
  assert.equal(h.state, "ok");
  assert.equal(sendHealthBlocksServing(h), false);
});

test("TOO FEW SENDS IS UNKNOWN, NEVER OK, and never blocks", () => {
  // Both halves matter. Answering `ok` on a quiet faucet would have it vouch for a
  // wallet nobody has exercised. Blocking would take the faucet down for being quiet.
  for (let n = 0; n < MIN_SAMPLE; n++) {
    const h = readSendHealth(NOW, many("failed", n));
    assert.equal(h.state, "unknown", `${n} sends should be unjudgeable`);
    assert.equal(sendHealthBlocksServing(h), false, `${n} sends must not block`);
  }
  // And one more decided send tips it into a real verdict.
  assert.equal(readSendHealth(NOW, many("failed", MIN_SAMPLE)).state, "degraded");
});

test("ONE FAILURE AMONG MANY IS NOT A DEAD WALLET", () => {
  // The over-counting direction. A refused address or a note-selection race is
  // ordinary, and paging on it trains an operator to ignore the page.
  const h = readSendHealth(NOW, [...many("ok", 9), at("failed")]);
  assert.equal(h.state, "ok");
  assert.equal(sendHealthBlocksServing(h), false);
});

test("AN UNRESOLVED SEND IS NOT A FAILURE: a slow wallet that also lands sends is not degraded", () => {
  // SendOutcomeUnknownError means the wallet holds an opid and may have broadcast.
  // Counting it as failure would let a slow wallet trip readiness and roll back a
  // deploy that was fine, which is the outage-amplifier the readiness route warns
  // about in its own comment. A slow wallet is one that produces unknowns AND a
  // success; unknowns with no success at all are the register #9 case, below.
  const h = readSendHealth(NOW, [...many("unknown", 8), at("ok")]);
  assert.equal(h.state, "unknown", "unresolved sends are not evidence of failure");
  assert.equal(sendHealthBlocksServing(h), false);
  assert.equal(h.unknown, 8, "but they are still reported, so an operator can see them");
  assert.equal(readSendHealth(NOW, [...many("unknown", 8), ...many("ok", 3)]).state, "ok");
});

test("and unknowns do not DILUTE a real failure rate either", () => {
  // The same mistake mirrored. If unknowns sat in the denominator, a run of slow sends
  // would push a genuine 100% failure rate under the threshold and hide it.
  const h = readSendHealth(NOW, [...many("failed", 4), ...many("unknown", 20)]);
  assert.equal(h.state, "degraded", "20 unresolved sends must not bury 4 outright failures");
  assert.equal(h.failed, 4);
  assert.equal(h.unknown, 20);
});

test("the threshold is not zero, or a single bad claim would page", () => {
  assert.ok(FAIL_RATIO > 0 && FAIL_RATIO <= 1, "a zero ratio pages on the first failure");
  // Exactly at the line counts as degraded: half the drips failing is not "mostly fine".
  const h = readSendHealth(NOW, [...many("ok", 3), ...many("failed", 3)]);
  assert.equal(h.state, "degraded");
});

test("A FAULT THAT HAS AGED OUT IS NOT CURRENT", () => {
  // Otherwise a wallet fixed twenty minutes ago is still reported as broken, and the
  // operator who fixed it cannot tell whether their fix worked.
  const old = Array.from({ length: 6 }, () => at("failed", WINDOW_MS + 1_000));
  assert.equal(readSendHealth(NOW, old).state, "unknown", "everything outside the window is gone");
  // A fresh success after an old fault reads as recovering, not as still-broken.
  const recovered = [...old, ...many("ok", 3)];
  assert.equal(readSendHealth(NOW, recovered).state, "ok");
});

test("recordSend trims by time, so the log cannot grow without bound", () => {
  resetSendHealth();
  recordSend("ok", NOW - WINDOW_MS - 5_000);
  recordSend("ok", NOW - WINDOW_MS - 4_000);
  recordSend("failed", NOW);
  // Reading through the module's own state rather than a passed array, so the trim and
  // the classifier are exercised together the way the route uses them.
  const h = readSendHealth(NOW);
  assert.equal(h.ok + h.failed + h.unknown, 1, "the two stale records should have been dropped on write");
  resetSendHealth();
});

test("a live record survives the trim, so trimming is not just deleting everything", () => {
  // The control for the test above. Without it, a trim that wiped the log would pass.
  resetSendHealth();
  recordSend("ok", NOW - 1_000);
  assert.equal(readSendHealth(NOW).ok, 1);
  resetSendHealth();
});

// ── EVERY SEND UNRESOLVED (risk register #9) ─────────────────────────────────────────────

test("A WALLET WHERE EVERY SEND TIMES OUT is degraded, not 'too few to judge' forever", () => {
  // The hole: unknowns were kept out of both the numerator and the denominator, so a
  // crash-looping zallet whose every send hit the deadline never produced a decided send
  // and this answered unknown for the whole outage: every claim a 504, every claimant a
  // burnt cooldown, readiness green.
  const h = readSendHealth(NOW, many("unknown", MIN_SAMPLE));
  assert.equal(h.state, "degraded");
  assert.equal(sendHealthBlocksServing(h), true);
  assert.match(h.reason, /never resolved and none succeeded/);
  assert.match(h.reason, new RegExp(`${MIN_SAMPLE} of the last ${MIN_SAMPLE} sends`));
});

test("but ONE success in the window clears it: that is what a slow-but-working wallet looks like", () => {
  // The over-counting direction this rule must not reopen. A wallet that broadcasts
  // slowly produces unknowns AND successes; only a dead one produces unknowns alone.
  const h = readSendHealth(NOW, [...many("unknown", 6), at("ok")]);
  assert.equal(h.state, "unknown", "one success and no failures is still too few decided sends to judge, not degraded");
  assert.equal(sendHealthBlocksServing(h), false);
  assert.equal(readSendHealth(NOW, [...many("unknown", 6), ...many("ok", MIN_SAMPLE)]).state, "ok");
});

test("fewer unresolved sends than the sample stay unknown, and unresolved plus failed with no success is degraded", () => {
  for (let n = 0; n < MIN_SAMPLE; n++) {
    assert.equal(readSendHealth(NOW, many("unknown", n)).state, "unknown", `${n} unresolved sends should be unjudgeable`);
  }
  // Two failures and three unresolved: decided is below the sample, nothing succeeded,
  // and the unresolved count carries it. The sentence counts both.
  const h = readSendHealth(NOW, [...many("unknown", 3), ...many("failed", 2)]);
  assert.equal(h.state, "degraded");
  assert.match(h.reason, /3 of the last 5 sends never resolved/);
});

test("an unresolved send AGES OUT of the window like the others, so a fixed wallet is not reported dead", () => {
  const stale = many("unknown", 5).map((r) => ({ ...r, at: NOW - WINDOW_MS - 1 }));
  assert.equal(readSendHealth(NOW, stale).state, "unknown");
  assert.match(readSendHealth(NOW, stale).reason, /too few to judge/);
});
