/**
 * claimBlocker: the read-only "would this be refused for a reason of the claimant's"
 * that /api/claimable asks before the puzzle. It must agree with what reserveClaim
 * would say, consume nothing, and never report the faucet's own daily cap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-claim-blocker-")));
process.env.DB_BACKEND = "sqlite";
process.env.RATE_LIMIT_SALT = "claim-blocker-salt";

const { reserveClaim, finalizeClaim, claimBlocker } = await import("./index.ts");

const NOW = 1_800_000_000;
const COOLDOWN = 86_400;
const base = { cooldownSeconds: COOLDOWN, subnetDailyMax: 100, ipDailyMax: 2 };

async function paid(address: string, ipHash: string, at: number, dailyCapZat = 1_000n) {
  const r = await reserveClaim({ ...base, address, ipHash, subnetHash: null, amountZat: 100n, now: at, dailyCapZat });
  if (r.ok) await finalizeClaim(r.claimId, "sent", `tx-${address}`, undefined, at * 1000);
  return r;
}

test("an unclaimed address on a fresh connection is not blocked, and asking twice changes nothing", async () => {
  const ask = () => claimBlocker({ ...base, address: "utest1fresh", ipHash: "ip-fresh", subnetHash: null, now: NOW });
  assert.equal(await ask(), null);
  assert.equal(await ask(), null, "the check wrote something it then counted");
  assert.equal((await paid("utest1fresh", "ip-fresh", NOW)).ok, true, "the claim after two checks was refused");
});

test("a paid address is refused as the ADDRESS, with the time left on its own cooldown", async () => {
  await paid("utest1paid", "ip-paid", NOW);
  const b = await claimBlocker({ ...base, address: "utest1paid", ipHash: "ip-other", subnetHash: null, now: NOW + 3600 });
  assert.equal(b?.kind, "cooldown");
  assert.equal(b?.scope, "address");
  assert.equal(b?.retryAfterSeconds, COOLDOWN - 3600);
  const real = await reserveClaim({ ...base, address: "utest1paid", ipHash: "ip-other", subnetHash: null, amountZat: 100n, now: NOW + 3600, dailyCapZat: 1_000n });
  assert.deepEqual(b, real, "the early answer differs from the one the claim gets");
});

test("a full connection is refused as the CONNECTION even for a new address", async () => {
  await paid("utest1home1", "ip-home", NOW);
  await paid("utest1home2", "ip-home", NOW + 60);
  const b = await claimBlocker({ ...base, address: "utest1home3", ipHash: "ip-home", subnetHash: null, now: NOW + 120 });
  assert.equal(b?.kind, "cooldown");
  assert.equal(b?.scope, "connection");
});

test("the faucet's own daily cap is NOT reported early, so the claim still says it itself", async () => {
  await paid("utest1cap", "ip-cap", NOW, 100n); // a cap of exactly one drip, now spent
  const b = await claimBlocker({ ...base, address: "utest1capnext", ipHash: "ip-capnext", subnetHash: null, now: NOW + 10 });
  assert.equal(b, null);
});
