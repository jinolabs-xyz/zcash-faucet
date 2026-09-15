/**
 * The one-time seed: on first read, surviving sent claims fold into their day
 * buckets, so the counter starts with the ~25 hours of history retention has not
 * yet deleted rather than at zero.
 *
 * Its own file, deliberately: node --test gives each file its own process, and the
 * seed only runs when `drip_days` is empty, a state the main drips suite destroys
 * with its first finalize. This is the only way to reach it through the real path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-dripseed-")));
process.env.DB_BACKEND = "sqlite";

const { SqliteDriver } = await import("./driver.ts");

const NOW_MS = Date.parse("2026-08-02T12:00:00Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);

// Plant history FIRST, through a raw driver, so the module under test wakes up to a
// world where claims exist and its counter table is empty: yesterday's rows and
// today's, plus a failed one that must not be counted.
const raw = new SqliteDriver();
const plant = (addr: string, status: string, atSec: number) =>
  raw.run(
    `INSERT INTO claims (address_hash, ip_hash, amount_zat, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    [`h-${addr}`, `ip-${addr}`, 100, status, atSec],
  );
// THE THIRD DAY BACK, which nothing reached before: the loop spans three days, not two,
// because a 25-hour retention window that starts just after a UTC midnight reaches into
// the day before yesterday. A row this old is past what retention normally keeps - the
// span of the loop is what is under test here, and without this the third leg could be
// deleted and every assertion in this file would still pass.
await plant("d2", "sent", NOW_SEC - 2 * 86_400 + 3_600);
await plant("y1", "sent", NOW_SEC - 86_400);
await plant("y2", "sent", NOW_SEC - 86_400 + 60);
await plant("t1", "sent", NOW_SEC - 60);
await plant("t-fail", "failed", NOW_SEC - 60);

const { countDrips } = await import("./index.ts");

test("first read seeds the buckets from surviving sent rows, once", async () => {
  const c = await countDrips(NOW_MS);
  assert.ok(c, "counter should answer");
  assert.equal(c.allTime, 4, "four sent survivors, the failed row not among them");
  assert.equal(c.last7d, 4);

  const dayOf = (back: number) => new Date(NOW_MS - back * 86_400_000).toISOString().slice(0, 10);
  const bucket = (day: string) =>
    raw.get<{ sent: number }>(`SELECT sent FROM drip_days WHERE network = 'taz' AND day = ?`, [day]);
  const yesterday = dayOf(1);
  assert.equal((await bucket(yesterday))?.sent, 2, "yesterday's two land in yesterday's bucket, not today's");
  assert.equal((await bucket(dayOf(2)))?.sent, 1, "and the day before that is seeded too, not dropped off the loop");
  assert.equal((await bucket(dayOf(0)))?.sent, 1, "today's one, the failed row excluded");

  // Replay safety: MAX semantics mean re-running the seed cannot double-count.
  // Reach it directly, since the in-process single-flight guard will not run twice.
  await raw.run(`INSERT INTO drip_days (network, day, sent) VALUES ('taz', ?, ?) ON CONFLICT(network, day) DO UPDATE SET sent = MAX(sent, excluded.sent)`, [yesterday, 2]);
  const again = await countDrips(NOW_MS);
  assert.equal(again?.allTime, 4, "a replayed seed must not inflate the count");
});
