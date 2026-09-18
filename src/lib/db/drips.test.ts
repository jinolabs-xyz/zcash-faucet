/**
 * The drip counter: how many drips were served, ever / last 7 UTC days / last 30.
 *
 * Lives in `drip_days`, not `claims`, because retention deletes claims rows after
 * ~25 hours and that is a feature. These tests read the bucket table directly for
 * the same reason finalize.test.ts reads the txid cell directly: the question is
 * what is stored, and an accessor is what would flatten the distinctions away.
 *
 * Time is injected everywhere. A test that computed "today" at assert time and
 * relied on it matching "today" at write time would flake across a UTC midnight,
 * which is rule 31's shape: red for a reason unrelated to the code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-drips-")));
process.env.DB_BACKEND = "sqlite";

const { reserveClaim, finalizeClaim, countDrips } = await import("./index.ts");
const { SqliteDriver } = await import("./driver.ts");

// A fixed instant, mid-day UTC so day arithmetic cannot straddle midnight.
const NOW_MS = Date.parse("2026-08-02T12:00:00Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);
const day = (msBack: number) => new Date(NOW_MS - msBack).toISOString().slice(0, 10);

const raw = new SqliteDriver();
const bucketOf = async (d: string, network = "taz") =>
  (await raw.get<{ sent: number }>(`SELECT sent FROM drip_days WHERE network = ? AND day = ?`, [network, d]))?.sent ?? null;

async function serveOne(addr: string, nowSec: number, nowMs: number) {
  const r = await reserveClaim({
    address: addr,
    ipHash: `ip-${addr}`,
    subnetHash: null,
    amountZat: 100n,
    now: nowSec,
    cooldownSeconds: 60,
    dailyCapZat: 1_000_000n,
    subnetDailyMax: 100,
  });
  assert.equal(r.ok, true, `reserve should succeed for ${addr}`);
  if (!r.ok) return;
  await finalizeClaim(r.claimId, "sent", `tx-${addr}`, undefined, nowMs);
}

// FIRST, BEFORE ANYTHING IS SERVED, because this is the only moment the table is empty and
// the distinction only exists here.
test("a counter that has counted nothing has no start date, and that is not day zero", async () => {
  const c = await countDrips(NOW_MS);
  assert.ok(c, "an empty table still answers");
  assert.equal(c.allTime, 0, "nothing served is a real zero");
  // THIS IS THE ROW THAT DISCRIMINATES, and it is worth saying so because the line that used to
  // sit below it did not. `assert.notEqual(typeof allTime, typeof countingSince)` reads like the
  // L51 shape - assert a DIFFERENCE rather than match a pattern - but with 0 and null already
  // pinned above, number-vs-object differ on every possible run. SDE-Infra measured it: restore
  // the `String(...)` defect, delete the two assertions above, and the file still passes 8/0.
  // It was a tautology wearing L51's clothes, in the fix for L51.
  assert.equal(c.countingSince, null,
    "an empty table has no first day; a '' or an epoch here is a date we invented");
});

test("a sent claim bumps today's bucket; a failed one does not", async () => {
  await serveOne("addr-a", NOW_SEC, NOW_MS);
  await serveOne("addr-b", NOW_SEC, NOW_MS);
  assert.equal(await bucketOf(day(0)), 2);

  const r = await reserveClaim({
    address: "addr-fail",
    ipHash: "ip-fail",
    subnetHash: null,
    amountZat: 100n,
    now: NOW_SEC,
    cooldownSeconds: 60,
    dailyCapZat: 1_000_000n,
    subnetDailyMax: 100,
  });
  assert.equal(r.ok, true);
  if (r.ok) await finalizeClaim(r.claimId, "failed", null, undefined, NOW_MS);
  assert.equal(await bucketOf(day(0)), 2, "a failed send is not a served drip");
});

test("the three windows cut where they claim to", async () => {
  // Buckets planted directly: inside 7d, inside 30d but not 7d, outside both.
  await raw.run(`INSERT INTO drip_days (network, day, sent) VALUES ('taz', ?, ?)`, [day(6 * 86_400_000), 10]);
  await raw.run(`INSERT INTO drip_days (network, day, sent) VALUES ('taz', ?, ?)`, [day(29 * 86_400_000), 100]);
  await raw.run(`INSERT INTO drip_days (network, day, sent) VALUES ('taz', ?, ?)`, [day(31 * 86_400_000), 1000]);

  const c = await countDrips(NOW_MS);
  assert.ok(c, "counter should answer");
  assert.equal(c.allTime, 2 + 10 + 100 + 1000);
  assert.equal(c.last30d, 2 + 10 + 100, "day 31 is outside the 30-day window");
  assert.equal(c.last7d, 2 + 10, "day 29 is outside the 7-day window");
});

test("the boundary day itself is inside the window", async () => {
  // day(6d) sits exactly on the 7-day cutoff ("today and the six before it"), and
  // the test above already counts it inside. This pins the off-by-one direction
  // explicitly so a >= that drifts to > fails a named assertion rather than a sum.
  const c = await countDrips(NOW_MS);
  assert.ok(c);
  assert.ok(c.last7d >= 10, "the 7th day back must be counted, >= not >");
});

test("networks do not pollute each other's counts", async () => {
  // A cTAZ drip lands in its own bucket. The TAZ readout must not move: mixed
  // rows cannot be separated retroactively, which is why network is part of the
  // key from day one rather than a migration later.
  const before = await countDrips(NOW_MS, "taz");
  assert.ok(before);
  const r = await reserveClaim({
    address: "addr-ctaz",
    ipHash: "ip-ctaz",
    subnetHash: null,
    amountZat: 100n,
    now: NOW_SEC,
    cooldownSeconds: 60,
    dailyCapZat: 1_000_000n,
    subnetDailyMax: 100,
  });
  assert.equal(r.ok, true);
  if (r.ok) await finalizeClaim(r.claimId, "sent", null, "network-has-no-txid", NOW_MS, "ctaz");
  assert.equal(await bucketOf(day(0), "ctaz"), 1, "the cTAZ drip lands in the ctaz bucket");
  const after = await countDrips(NOW_MS, "taz");
  assert.equal(after?.allTime, before.allTime, "the TAZ count must not move");
  const ctaz = await countDrips(NOW_MS, "ctaz");
  assert.equal(ctaz?.allTime, 1);
});

test("counts survive the claims purge, which is the reason this table exists", async () => {
  // Age every claims row past retention and run a reserve (which purges), then
  // recount: the buckets must be untouched by claims deletion.
  await raw.run(`UPDATE claims SET created_at = ?`, [NOW_SEC - 10 * 86_400]);
  await serveOne("addr-later", NOW_SEC, NOW_MS);
  const survivors = await raw.get<{ n: number }>(`SELECT COUNT(*) AS n FROM claims`, []);
  assert.ok(Number(survivors?.n) <= 2, "old claims rows should be purged");
  const c = await countDrips(NOW_MS);
  assert.ok(c);
  assert.equal(c.allTime, 2 + 10 + 100 + 1000 + 1, "purging claims must not lose counts");
});

test("the counter says which day it started, and it is not the day you asked on", async () => {
  const c = await countDrips(NOW_MS);
  assert.ok(c);
  // The oldest bucket planted above, 31 days back and outside every window - so this is the
  // one figure on the surface that reaches past the windows beside it.
  assert.equal(c.countingSince, day(31 * 86_400_000));
  assert.notEqual(c.countingSince, day(0),
    "a start date equal to today would make 'counted since' say nothing at all");
});

test("the start date is the network's own, not the ledger's earliest row", async () => {
  // cTAZ's only bucket is today's, planted by the per-network test above; TAZ reaches back 31
  // days. If MIN(day) ever escapes the `WHERE network = ?` both answers become the same day,
  // and the cTAZ figure would claim a history that belongs to TAZ.
  const taz = await countDrips(NOW_MS, "taz");
  const ctaz = await countDrips(NOW_MS, "ctaz");
  assert.ok(taz && ctaz);
  assert.equal(ctaz.countingSince, day(0));
  assert.notEqual(ctaz.countingSince, taz.countingSince,
    "two networks with different histories must not report the same start date");
});
