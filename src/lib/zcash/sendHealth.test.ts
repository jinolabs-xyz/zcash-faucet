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
  windowMinutes,
  MIN_SAMPLE,
  FAIL_ALONE,
  FAIL_RATIO,
  readSendHealthServed,
  servedNetworks,
  type SendRecord,
} from "./sendHealth.ts";
import { config } from "../config.ts";

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
  // "Too few" is fewer than FAIL_ALONE failures with nothing else (R-18): two failures
  // and no success are a verdict now, so the quiet range is 0 and 1.
  for (let n = 0; n < FAIL_ALONE; n++) {
    const h = readSendHealth(NOW, many("failed", n));
    assert.equal(h.state, "unknown", `${n} sends should be unjudgeable`);
    assert.equal(sendHealthBlocksServing(h), false, `${n} sends must not block`);
  }
  // A single success beside a single failure is the ratio rule's, and it needs its sample.
  assert.equal(readSendHealth(NOW, [...many("ok", 1), ...many("failed", 1)]).state, "unknown");
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
  recordSend("ok", "taz", NOW - WINDOW_MS - 5_000);
  recordSend("ok", "taz", NOW - WINDOW_MS - 4_000);
  recordSend("failed", "taz", NOW);
  // Reading through the module's own state rather than a passed array, so the trim and
  // the classifier are exercised together the way the route uses them.
  const h = readSendHealth(NOW);
  assert.equal(h.ok + h.failed + h.unknown, 1, "the two stale records should have been dropped on write");
  resetSendHealth();
});

test("a live record survives the trim, so trimming is not just deleting everything", () => {
  // The control for the test above. Without it, a trim that wiped the log would pass.
  resetSendHealth();
  recordSend("ok", "taz", NOW - 1_000);
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
  // Failures alone with no unknown: three refusals are the ratio rule's, with its
  // sentence; two are FAIL_ALONE's (R-18), with theirs.
  assert.match(readSendHealth(NOW, many("failed", 3)).reason, /3 of the last 3 sends failed$/);
  assert.match(readSendHealth(NOW, many("failed", 2)).reason, /2 of the last 2 sends failed and none succeeded/);
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
  assert.equal(windowFor(1_929_000), 2 * 1_929_000 + 60_000, "ZALLET_OP_TIMEOUT_MS at 30 min still fits three deadline-spaced unknowns");
  // The sentence prints whole minutes. In CI's env the window is the 15 min floor, where
  // rounding is a no-op, so the rounding is pinned on a DERIVED window here, not on the
  // sentence alone: 1_118_000 ms is 18.633 min and must read 19.
  assert.equal(windowMinutes(windowFor(529_000)), 19);
  assert.equal(windowMinutes(windowFor(1_929_000)), 65);
  assert.match(readSendHealth(NOW, []).reason, new RegExp(`in the last ${windowMinutes(WINDOW_MS)} min, too few to judge`));
  const spaced = Array.from({ length: MIN_SAMPLE }, (_, i) => at("unknown", i * deadline));
  assert.equal(readSendHealth(NOW, spaced).state, "degraded", "deadline-spaced unknowns must fit the window");
});

test("an unresolved send AGES OUT of the window like the others, so a fixed wallet is not reported dead", () => {
  const stale = many("unknown", 5).map((r) => ({ ...r, at: NOW - WINDOW_MS - 1 }));
  assert.equal(readSendHealth(NOW, stale).state, "unknown");
  assert.match(readSendHealth(NOW, stale).reason, /too few to judge/);
});

/* ------------------------------------------ the quiet faucet (risk register II, R-18) */

test("TWO FAILURES AND NO SUCCESS IS A VERDICT, not 'too few to judge'", () => {
  // Production does about nine drips a day. Under the sample rule alone a wallet that
  // refused every send was never judged: the third failure arrived after the first
  // had aged out. Two strangers failing in a row with nothing landing in between is
  // the wallet, not the claims.
  const now = 1_000_000;
  const h = readSendHealth(now, [{ outcome: "failed", at: now - 60_000 }, { outcome: "failed", at: now - 1_000 }]);
  assert.equal(h.state, "degraded");
  assert.match(h.reason, /2 of the last 2 sends failed and none succeeded/);
  assert.equal(sendHealthBlocksServing(h), true);
});

test("but ONE failure alone is still a blip, and one failure beside one success is still too few", () => {
  const now = 1_000_000;
  assert.equal(readSendHealth(now, [{ outcome: "failed", at: now - 1_000 }]).state, "unknown");
  const mixed = readSendHealth(now, [{ outcome: "ok", at: now - 60_000 }, { outcome: "failed", at: now - 1_000 }]);
  assert.equal(mixed.state, "unknown", "a success in the window means the ratio rule decides, and it needs its sample");
});

test("a success AFTER two failures clears it: the rule is about a wallet that lands nothing", () => {
  const now = 1_000_000;
  const h = readSendHealth(now, [
    { outcome: "failed", at: now - 120_000 },
    { outcome: "failed", at: now - 60_000 },
    { outcome: "ok", at: now - 1_000 },
  ]);
  // Three decided: the ratio rule, 2/3 failed, is still degraded on its own terms.
  assert.equal(h.state, "degraded");
  const recovered = readSendHealth(now, [
    { outcome: "failed", at: now - 180_000 },
    { outcome: "failed", at: now - 120_000 },
    { outcome: "ok", at: now - 60_000 },
    { outcome: "ok", at: now - 30_000 },
    { outcome: "ok", at: now - 1_000 },
  ]);
  assert.equal(recovered.state, "ok");
});

/* ------------------------------------------------------------------------- *
 * #528: the two kinds of unresolved, and only one of them is a verdict.
 * ------------------------------------------------------------------------- */

/** A z_sendmany whose REPLY was lost: no opid, we do not know the wallet heard us. */
const lost = (agoMs = 0): SendRecord => ({ outcome: "unknown", at: NOW - agoMs, unanswered: true });
const manyLost = (n: number) => Array.from({ length: n }, () => lost());

test("#528: A WALLET THAT NEVER ANSWERS z_sendmany IS DEGRADED, even with a success beside it", () => {
  // The regression #527 introduced by being more honest. Two sends in three losing their
  // reply read `1 ok, 2 unknown` -> "too few to judge", where the same wallet before #527
  // read `1 ok, 2 failed` -> degraded. Meanwhile each of those two burnt a stranger's
  // cooldown for the whole day (route.ts, #88), which an outright failure does not.
  const h = readSendHealth(NOW, [at("ok"), ...manyLost(2)]);
  assert.equal(h.state, "degraded");
  assert.equal(sendHealthBlocksServing(h), true);
  assert.match(h.reason, /2 of the last 3 sends failed or went unanswered/);
});

test("#528 THE PARTNER: the same shape WITH an opid is still not a verdict", () => {
  // Without this row every assertion above is satisfied by "any unresolved send now
  // counts", which would undo the rule at the top of this file and hand a slow wallet the
  // power to fail readiness and roll back a good deploy. The KIND is what counts, not the
  // bucket, so the identical arithmetic must come out differently.
  const h = readSendHealth(NOW, [at("ok"), ...many("unknown", 2)]);
  assert.equal(h.state, "unknown", "an opid means the wallet took the job; that is not a fault");
  assert.equal(sendHealthBlocksServing(h), false);
});

test("#528: the slow-but-working wallet is left exactly as it was", () => {
  // The two cases the module already decided, re-asserted against the new counting so a
  // later widening cannot quietly take them with it.
  assert.equal(readSendHealth(NOW, [...many("unknown", 8), at("ok")]).state, "unknown");
  assert.equal(readSendHealth(NOW, [...many("unknown", 8), ...many("ok", 3)]).state, "ok");
});

test("#528: two lost replies and no success is a verdict, exactly as two failures are", () => {
  const h = readSendHealth(NOW, manyLost(FAIL_ALONE));
  assert.equal(h.state, "degraded");
  assert.match(h.reason, /2 of the last 2 sends failed or went unanswered and none succeeded/);
});

test("#528: the sentence never calls a lost reply a failure, nor a failure a lost reply", () => {
  // An operator told "3 sends failed" goes looking for an error the wallet never sent.
  assert.match(readSendHealth(NOW, many("failed", 3)).reason, /3 of the last 3 sends failed$/);
  assert.match(readSendHealth(NOW, [at("ok"), ...manyLost(2)]).reason, /went unanswered/);
  assert.doesNotMatch(readSendHealth(NOW, many("failed", 3)).reason, /unanswered/);
});

test("#528: BOTH kinds are still reported as unknown, because an operator wants to see them all", () => {
  const h = readSendHealth(NOW, [at("ok"), ...manyLost(2), ...many("unknown", 2)]);
  assert.equal(h.unknown, 4, "counting them differently must not hide any of them");
});

/* ------------------------------------------------------------------------- *
 * #517: the log is per wallet, because the wallets are per network.
 * ------------------------------------------------------------------------- */

const on = (network: "taz" | "ctaz", outcome: "ok" | "failed" | "unknown", n: number): SendRecord[] =>
  Array.from({ length: n }, () => ({ outcome, at: NOW, network }));

test("#517: a degraded TAZ wallet does not refuse cTAZ claims, and the reverse", () => {
  // Different wallets paying from different balances. Neither is evidence about the other,
  // and refusing a working one is an outage we inflicted on ourselves.
  const records = [...on("taz", "failed", 4), ...on("ctaz", "ok", 4)];
  assert.equal(readSendHealth(NOW, records, "taz").state, "degraded");
  assert.equal(readSendHealth(NOW, records, "ctaz").state, "ok");

  const mirrored = [...on("ctaz", "failed", 4), ...on("taz", "ok", 4)];
  assert.equal(readSendHealth(NOW, mirrored, "ctaz").state, "degraded");
  assert.equal(readSendHealth(NOW, mirrored, "taz").state, "ok");
});

test("#517: one network's sends do not pad the other's SAMPLE either", () => {
  // The quieter half of the same bug. If the other wallet's records stayed in the window
  // they would not only carry verdicts across, they would make a network with two sends
  // look like one with six, and MIN_SAMPLE would stop protecting it.
  const records = [...on("ctaz", "ok", 9), ...on("taz", "failed", 1)];
  assert.equal(readSendHealth(NOW, records, "taz").state, "unknown", "one TAZ failure is not a sample");
  assert.equal(readSendHealth(NOW, records, "taz").failed, 1);
  assert.equal(readSendHealth(NOW, records, "taz").ok, 0, "cTAZ successes must not vouch for TAZ");
});

test("#517: a record written before networks were tracked counts, rather than being dropped", () => {
  // Discarding them would silently shrink the sample, which is worse than attributing them
  // to the wallet they almost certainly used.
  const legacy = many("failed", 4);  // no network field at all
  assert.equal(readSendHealth(NOW, legacy, "taz").state, "degraded");
  assert.equal(readSendHealth(NOW, legacy, "ctaz").state, "unknown", "and they belong to ONE network, not both");
});

test("#517: recordSend files a send under the network that made it", () => {
  resetSendHealth();
  recordSend("failed", "ctaz", NOW);
  recordSend("failed", "ctaz", NOW);
  recordSend("failed", "ctaz", NOW);
  assert.equal(readSendHealth(NOW, undefined, "ctaz").state, "degraded");
  assert.equal(readSendHealth(NOW, undefined, "taz").state, "unknown");
  resetSendHealth();
});

/* --- the whole faucet's verdict, not just the primary wallet's (#517, review) --- */

test("#517: a dead cTAZ wallet is NOT invisible to readiness while cTAZ is served", () => {
  // The regression review caught: readSendHealth() defaults to TAZ, so ready and status
  // asking it bare would have narrowed both to one wallet by accident.
  const records = [...on("ctaz", "failed", 4), ...on("taz", "ok", 4)];
  assert.equal(readSendHealth(NOW, records).state, "ok", "the primary wallet alone looks fine");
  const served = readSendHealthServed(NOW, records, ["taz", "ctaz"]);
  assert.equal(served.state, "degraded");
  assert.equal(sendHealthBlocksServing(served), true);
  assert.match(served.reason, /^ctaz: /, "and it names which of two wallets to go and look at");
});

test("#517: a PARKED network cannot block serving, because nobody can claim from it", () => {
  const records = [...on("ctaz", "failed", 4), ...on("taz", "ok", 4)];
  const served = readSendHealthServed(NOW, records, ["taz"]);
  assert.equal(served.state, "ok");
  assert.equal(sendHealthBlocksServing(served), false);
});

test("#517: the primary wallet's own verdict is not renamed", () => {
  const records = [...on("taz", "failed", 4), ...on("ctaz", "ok", 4)];
  const served = readSendHealthServed(NOW, records, ["taz", "ctaz"]);
  assert.equal(served.state, "degraded");
  assert.doesNotMatch(served.reason, /^taz: /, "one wallet is the default; saying so adds noise");
});

test("servedNetworks follows the crosslink switch, so a parked wallet is dropped by config", () => {
  const served = servedNetworks();
  assert.ok(served.includes("taz"), "the primary network is always served");
  assert.equal(served.includes("ctaz"), config.crosslink.enabled);
});

test("#528: a degraded verdict resting on lost replies reports them, so the numbers match the sentence", () => {
  // failed: 0 beside "4 of the last 5 sends failed or went unanswered" reads as a
  // contradiction on the status page. Raised in review.
  const h = readSendHealth(NOW, [at("ok"), ...manyLost(4)]);
  assert.equal(h.state, "degraded");
  assert.equal(h.failed, 0);
  assert.equal(h.unanswered, 4, "the sentence's number has to appear in the fields");
  assert.match(h.reason, /4 of the last 5 sends failed or went unanswered/);
});
