/**
 * What the connection refusal SAYS, driven through reserveClaim so it is the real path:
 * the gate refuses, whyBlocked explains, and the explanation is what a user reads.
 *
 * ipHousehold.test.ts proves the gate; nothing proved the explanation, and review found
 * it wrong in the way that matters. With N drips per window, the next slot opens at the
 * EARLIEST EXPIRY among the live claims - and each claim expires on its own window: a
 * sent row after the cooldown, a pending row after the (much shorter) lease. The first
 * cut took the oldest created_at and added the cooldown to it whatever the status.
 * Measured: five devices claim and stay pending behind a slow sender, the sixth is told
 * 23h 59m, and the slot actually opened in 1h 48m. That number was then stamped onto a
 * confident wall-clock nextAt, which is the "not an outage" message becoming one.
 *
 * Config is pinned before import because PENDING_LEASE_SECONDS is derived from it at
 * load: a lease much shorter than the cooldown is the whole point of these tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-ip-retry-")));
process.env.DB_BACKEND = "sqlite";
process.env.RATE_LIMIT_SALT = "ip-retry-salt";

const { reserveClaim, finalizeClaim, PENDING_LEASE_SECONDS } = await import("./index.ts");

const NOW = 1_800_000_000;
const COOLDOWN = 86_400;
const IP_MAX = 3;

async function claim(addr: string, ip: string, at: number, finalize: boolean) {
  const r = await reserveClaim({
    address: addr,
    ipHash: ip,
    subnetHash: null,
    amountZat: 100n,
    now: at,
    cooldownSeconds: COOLDOWN,
    dailyCapZat: 1_000_000_000n,
    subnetDailyMax: 100,
    ipDailyMax: IP_MAX,
  });
  if (r.ok && finalize) await finalizeClaim(r.claimId, "sent", `tx-${addr}`, undefined, at * 1000);
  return r;
}

test("PRECONDITION: the lease is much shorter than the cooldown, or these tests prove nothing", () => {
  // If the two windows were equal, per-status and single-window arithmetic would agree
  // and every assertion below would pass against the bug it exists to catch.
  assert.ok(PENDING_LEASE_SECONDS < COOLDOWN / 4, `lease ${PENDING_LEASE_SECONDS}s vs cooldown ${COOLDOWN}s`);
});

test("a full connection is told when the EARLIEST claim expires, measured on ITS window", async () => {
  const ip = "home-sent";
  // Three SENT claims an hour apart. The earliest expires first, at t0 + COOLDOWN.
  for (let i = 0; i < IP_MAX; i++) {
    const r = await claim(`s-${i}`, ip, NOW + i * 3600, true);
    assert.equal(r.ok, true, `device ${i} should be paid`);
  }
  const at = NOW + 3 * 3600;
  const refused = await claim("s-late", ip, at, true);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.kind, "cooldown");
  assert.match(refused.reason, /connection/i, "the reason must name the connection, not the address");
  // Oldest sent claim was at NOW; it frees at NOW + COOLDOWN.
  assert.equal(refused.retryAfterSeconds, NOW + COOLDOWN - at, "measured from the EARLIEST claim's expiry");
});

test("a PENDING claim frees a slot after the lease, not after the cooldown", async () => {
  // The bug review measured. Everyone's send is stuck behind a slow wallet, so all three
  // rows are pending. They block for the LEASE, and the refusal has to say so.
  const ip = "home-pending";
  for (let i = 0; i < IP_MAX; i++) {
    const r = await claim(`p-${i}`, ip, NOW + i, false);
    assert.equal(r.ok, true, `device ${i} should have reserved`);
  }
  const at = NOW + 60;
  const refused = await claim("p-late", ip, at, false);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  const expected = NOW + PENDING_LEASE_SECONDS - at;
  assert.equal(
    refused.retryAfterSeconds,
    expected,
    `told ${refused.retryAfterSeconds}s; the earliest pending row frees in ${expected}s, not ${COOLDOWN - 60}s`,
  );
  // And the promise has to be TRUE: one second after that, the claim goes through.
  const after = await claim("p-late", ip, NOW + PENDING_LEASE_SECONDS + 1, false);
  assert.equal(after.ok, true, "the slot the refusal promised must actually exist when promised");
});

test("mixed sent and pending: the answer is the earliest EXPIRY, which need not be the oldest ROW", async () => {
  // A sent row created first and a pending row created later: the pending one expires
  // sooner despite being younger. MIN(created_at) picks the wrong row here; MIN(expiry)
  // picks the right one. This is the case that separates the two formulas.
  const ip = "home-mixed";
  assert.equal((await claim("m-sent", ip, NOW, true)).ok, true);
  assert.equal((await claim("m-pend-1", ip, NOW + 100, false)).ok, true);
  assert.equal((await claim("m-pend-2", ip, NOW + 200, false)).ok, true);
  const at = NOW + 300;
  const refused = await claim("m-late", ip, at, false);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  // Earliest expiry is the first PENDING row: NOW + 100 + lease. The sent row's expiry
  // (NOW + COOLDOWN) is far later even though it was created first.
  assert.equal(refused.retryAfterSeconds, NOW + 100 + PENDING_LEASE_SECONDS - at);
});

test("the refusal never names a transaction", async () => {
  // The address branch used to return the txid that paid the address. Review showed that
  // to be an oracle - anyone who knows an address can learn which transaction paid it for
  // one proof-of-work - so it is gone from every branch, and this pins that it stays gone.
  const ip = "home-oracle";
  assert.equal((await claim("o-1", ip, NOW, true)).ok, true);
  const again = await claim("o-1", ip, NOW + 10, true); // same address: the ADDRESS branch
  assert.equal(again.ok, false);
  assert.doesNotMatch(JSON.stringify(again), /tx-o-1/, "an address refusal must not disclose its txid");
  for (let i = 1; i < IP_MAX; i++) assert.equal((await claim(`o-${i + 1}`, ip, NOW + 20 + i, true)).ok, true);
  const full = await claim("o-late", ip, NOW + 100, true); // the CONNECTION branch
  assert.equal(full.ok, false);
  assert.doesNotMatch(JSON.stringify(full), /tx-o-/, "a connection refusal must not disclose anyone's txid");
});
