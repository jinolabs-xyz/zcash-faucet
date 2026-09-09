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
  windowFor,
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

test("fewer unresolved sends than the sample stay unknown", () => {
  for (let n = 0; n < MIN_SAMPLE; n++) {
    assert.equal(readSendHealth(NOW, many("unknown", n)).state, "unknown", `${n} unresolved sends should be unjudgeable`);
  }
});

test("THE MIXED CRASH LOOP: unresolved PLUS failed with no success is degraded, even with too few of either alone", () => {
  // The likelier shape. A crash-looping zallet alternates connection refused (failed)
  // and a lost opid (unknown), so on a quiet window neither count reaches the sample by
  // itself. Review measured ok=0 failed=2 unknown=2 reading "too few to judge": four
  // claimants paid nothing, readiness 200.
  for (const [u, f] of [[2, 1], [1, 2], [2, 2]] as const) {
    const h = readSendHealth(NOW, [...many("unknown", u), ...many("failed", f)]);
    assert.equal(h.state, "degraded", `unknown=${u} failed=${f}`);
    assert.equal(sendHealthBlocksServing(h), true, `unknown=${u} failed=${f}`);
    assert.match(h.reason, new RegExp(`${u} of the last ${u + f} sends never resolved`));
  }
  // Enough failures for the ratio rule on their own: that rule answers, with its own
  // sentence, and the verdict is the same.
  const ratio = readSendHealth(NOW, [...many("unknown", 1), ...many("failed", 5)]);
  assert.equal(ratio.state, "degraded");
  assert.match(ratio.reason, /5 of the last 5 sends failed/);
  // Failures alone with no unknown are the ratio rule's: three refusals read degraded
  // through it, two read too few to judge, unchanged.
  assert.match(readSendHealth(NOW, many("failed", 3)).reason, /3 of the last 3 sends failed/);
  assert.equal(readSendHealth(NOW, many("failed", 2)).state, "unknown");
});

test("THE WINDOW HOLDS A SAMPLE OF DEADLINE-SPACED UNKNOWNS, so the deadline class can trip the rule at all", async () => {
  // The queue is serial and a send that blew its deadline is still running, so
  // consecutive deadline unknowns are at least one deadline apart. Review measured a
  // 10 min window reading degraded at 300 s spacing and "too few" at 301 s, with the
  // stock deadline at 309 s: the exact class the rule was written for could never fit.
  const { config } = await import("../config.ts");
  const deadline = config.sendTaskDeadlineMs; // whatever this environment's timings make it
  assert.ok(
    (MIN_SAMPLE - 1) * deadline + 60_000 <= WINDOW_MS,
    `${MIN_SAMPLE} unknowns ${deadline} ms apart need ${(MIN_SAMPLE - 1) * deadline} ms plus a minute; the window is ${WINDOW_MS}`,
  );
  assert.equal(WINDOW_MS, windowFor(deadline), "the window in force IS the derived one");
  // The derivation itself: the floor at stock timings, and growth past the break-even
  // review measured (an op timeout above 321 s made a 15 min constant stop fitting).
  assert.equal(windowFor(309_000), 15 * 60_000);
  assert.equal(windowFor(451_000), 2 * 451_000 + 60_000);
  assert.ok(windowFor(1_929_000) >= 2 * 1_929_000 + 60_000, "ZALLET_OP_TIMEOUT_MS at 30 min still fits three deadline-spaced unknowns");
  const spaced = Array.from({ length: MIN_SAMPLE }, (_, i) => at("unknown", i * deadline));
  assert.equal(readSendHealth(NOW, spaced).state, "degraded", "deadline-spaced unknowns must fit the window");
});

test("an unresolved send AGES OUT of the window like the others, so a fixed wallet is not reported dead", () => {
  const stale = many("unknown", 5).map((r) => ({ ...r, at: NOW - WINDOW_MS - 1 }));
  assert.equal(readSendHealth(NOW, stale).state, "unknown");
  assert.match(readSendHealth(NOW, stale).reason, /too few to judge/);
});
