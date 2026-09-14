/**
 * The global daily cap says WHEN it has room again (risk register II, R-34).
 *
 * "Come back tomorrow" was the whole answer, whatever the clock said. The cap is a
 * rolling 24 h sum, so the honest answer is the earliest expiry among the rows it
 * counts: a sent row leaves the sum 24 h after it was made, a pending one at the end
 * of its lease. The connection refusal has measured its own answer that way since the
 * per-IP window landed; this pins that the cap does the same, from the same rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-cap-retry-")));
process.env.DB_BACKEND = "sqlite";
process.env.RATE_LIMIT_SALT = "cap-retry-salt";

const { reserveClaim, finalizeClaim, PENDING_LEASE_SECONDS } = await import("./index.ts");

const NOW = 1_800_000_000;
const COOLDOWN = 86_400;
const DRIP = 100n;
const CAP = 3n * DRIP; // three drips a day, so the fourth is the one refused

async function claim(addr: string, at: number, finalize: boolean, network: "taz" | "ctaz" = "taz") {
  const r = await reserveClaim({
    address: addr,
    ipHash: `ip-${addr}`, // one IP per claim, so only the cap can refuse
    subnetHash: null,
    amountZat: DRIP,
    now: at,
    cooldownSeconds: COOLDOWN,
    dailyCapZat: CAP,
    subnetDailyMax: 100,
    ipDailyMax: 1,
    network,
  });
  if (r.ok && finalize) await finalizeClaim(r.claimId, "sent", `tx-${addr}`, undefined, at * 1000, network);
  return r;
}

test("a full cap says when the EARLIEST counted drip leaves the window", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await claim(`s-${i}`, NOW + i * 3600, true)).ok, true, `drip ${i} should be paid`);
  const at = NOW + 3 * 3600;
  const refused = await claim("s-late", at, true);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.kind, "cap");
  assert.equal(refused.retryAfterSeconds, NOW + COOLDOWN - at, "measured from the oldest sent drip's expiry, not 'tomorrow'");
});

test("a PENDING drip frees cap room at the end of its lease, not a day later", async () => {
  // Cap is per network, so a second network is a fresh window. Three pending rows (a
  // slow wallet), a fourth refused: the room opens when the first lease ends.
  for (let i = 0; i < 3; i++) assert.equal((await claim(`p-${i}`, NOW + i, false, "ctaz")).ok, true);
  const at = NOW + 30;
  const refused = await claim("p-late", at, false, "ctaz");
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.kind, "cap");
  assert.equal(refused.retryAfterSeconds, NOW + PENDING_LEASE_SECONDS - at);
  assert.ok(refused.retryAfterSeconds! < COOLDOWN / 4, "a lease is far shorter than a day, or this proves nothing");
});
