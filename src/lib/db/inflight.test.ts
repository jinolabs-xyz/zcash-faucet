import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real sqlite ledger in a throwaway dir, exercised through the production
// reserveClaim/finalizeClaim path rather than raw SQL, so this asserts what
// the route actually gets.
process.chdir(mkdtempSync(join(tmpdir(), "faucet-inflight-")));
process.env.DB_BACKEND = "sqlite";

const { reserveClaim, finalizeClaim, PENDING_LEASE_SECONDS } = await import("./index.ts");
const { config } = await import("../config.ts");
const { pendingLeaseSeconds, PENDING_LEASE_MARGIN_SECONDS } = await import("./sql.ts");

test("THE LEASE OUTLASTS A LEGAL SEND (risk register #8)", () => {
  // 120 s against a 309 s send budget: a slow shielded send unblocked its own address at
  // two minutes, still pending, and a retry paid a second drip while the first was being
  // built. The lease is derived from the same budget, with a margin for the finalise.
  assert.ok(
    PENDING_LEASE_SECONDS * 1000 > config.sendTaskDeadlineMs,
    `lease ${PENDING_LEASE_SECONDS}s does not outlast the ${config.sendTaskDeadlineMs} ms send deadline`,
  );
  assert.equal(PENDING_LEASE_SECONDS, pendingLeaseSeconds(config.sendTaskDeadlineMs));
  assert.equal(pendingLeaseSeconds(309_000), 309 + PENDING_LEASE_MARGIN_SECONDS);
  assert.equal(pendingLeaseSeconds(120_001), 121 + PENDING_LEASE_MARGIN_SECONDS, "rounds the deadline UP to whole seconds");
  assert.ok(PENDING_LEASE_MARGIN_SECONDS >= 30, "the margin covers the finalise write after the deadline");
});

test("a second claim for the same address INSIDE the send budget is refused, even past two minutes", async () => {
  // The #8 window itself: the first claim is still pending (the send is in flight,
  // legally, at 121 s), and the old lease had already released it.
  // More than a day BEFORE every other case's clock: the daily-cap SUM has no upper
  // bound on created_at, so a row stamped in another case's future would count against
  // its cap.
  const now = 1_799_000_000;
  const address = "utest1slow-send";
  const first = await reserve(address, now);
  assert.equal(first.ok, true);
  const atTwoMinutes = await reserve(address, now + 121);
  assert.equal(atTwoMinutes.ok, false, "121 s into a legal send the address must still be held");
  const atDeadline = await reserve(address, now + Math.ceil(config.sendTaskDeadlineMs / 1000));
  assert.equal(atDeadline.ok, false, "and at the deadline itself, before the route has finalised");
});

const COOLDOWN = 86_400;
const CAP = 100_000_000_000n;
const DRIP = 10_000_000n;
const reserve = (address: string, now: number) =>
  // subnetHash null skips the subnet rule, so this file still exercises only the
  // cooldown and cap behaviour it names.
  reserveClaim({ address, ipHash: null, subnetHash: null, amountZat: DRIP, now,
    cooldownSeconds: COOLDOWN, dailyCapZat: CAP, subnetDailyMax: 1_000_000 });

test("a send we lost track of keeps blocking past the pending lease", async () => {
  // The bug (#51): the kept reservation stayed 'pending', and pending rows only
  // block for PENDING_LEASE_SECONDS. The wallet holds an opid and may broadcast
  // minutes later, so the address must stay blocked for the full cooldown.
  const now = 1_800_000_000;
  const address = "utest1lost-track";

  const first = await reserve(address, now);
  assert.equal(first.ok, true, "first claim should reserve");

  // What the route does on SendOutcomeUnknownError: assume paid, record the
  // opid for reconciliation.
  await finalizeClaim(first.claimId, "sent", "opid-in-flight-123");

  const afterLease = await reserve(address, now + PENDING_LEASE_SECONDS + 1);
  assert.equal(afterLease.ok, false, "address reserved again 121s after a lost-track send, double payout");

  const nextDay = await reserve(address, now + COOLDOWN + 1);
  assert.equal(nextDay.ok, true, "the block must expire with the normal cooldown, not last forever");
});

test("the in-flight amount still counts toward the daily cap after the lease", async () => {
  // Pending rows drop out of the cap SUM once the lease passes. If a lost-track
  // send stopped counting, a stream of them could blow through the daily cap.
  const now = 1_800_100_000;
  const capForTwo = DRIP * 2n;
  const tight = (address: string, at: number) =>
    reserveClaim({ address, ipHash: null, subnetHash: null, amountZat: DRIP, now: at,
      cooldownSeconds: COOLDOWN, dailyCapZat: capForTwo, subnetDailyMax: 1_000_000 });

  const a = await tight("utest1cap-a", now);
  assert.equal(a.ok, true);
  await finalizeClaim(a.claimId, "sent", "opid-cap-a");

  const b = await tight("utest1cap-b", now + PENDING_LEASE_SECONDS + 1);
  assert.equal(b.ok, true, "second claim is within the cap");
  await finalizeClaim(b.claimId, "sent", "opid-cap-b");

  const overCap = await tight("utest1cap-c", now + PENDING_LEASE_SECONDS + 2);
  assert.equal(overCap.ok, false, "third claim must be refused, the in-flight two already spent the cap");
  assert.equal(overCap.kind, "cap");
});

test("a genuinely dead send still releases on the lease, so nobody is locked out", async () => {
  // The lease is right for its original purpose: a process that died mid-send
  // must not hold someone's cooldown hostage. Only the lost-track path changes.
  const now = 1_800_200_000;
  const address = "utest1dead-process";

  const first = await reserve(address, now);
  assert.equal(first.ok, true);
  // No finalize at all: the process died before it could record anything.

  const withinLease = await reserve(address, now + 10);
  assert.equal(withinLease.ok, false, "should still block inside the lease");

  const afterLease = await reserve(address, now + PENDING_LEASE_SECONDS + 1);
  assert.equal(afterLease.ok, true, "a dead pending claim must release on the lease");
});

test("an explicitly failed send releases immediately", async () => {
  const now = 1_800_300_000;
  const address = "utest1clean-failure";

  const first = await reserve(address, now);
  assert.equal(first.ok, true);
  await finalizeClaim(first.claimId, "failed", null);

  const retry = await reserve(address, now + 1);
  assert.equal(retry.ok, true, "a definite failure must let the user retry at once");
});
