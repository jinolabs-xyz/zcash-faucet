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
await plant("y1", "sent", NOW_SEC - 86_400);
await plant("y2", "sent", NOW_SEC - 86_400 + 60);
await plant("t1", "sent", NOW_SEC - 60);
await plant("t-fail", "failed", NOW_SEC - 60);

const { countDrips } = await import("./index.ts");

test("first read seeds the buckets from surviving sent rows, once", async () => {
  const c = await countDrips(NOW_MS);
  assert.ok(c, "counter should answer");
  assert.equal(c.allTime, 3, "three sent survivors, the failed row not among them");
  assert.equal(c.last7d, 3);

  const yesterday = new Date(NOW_MS - 86_400_000).toISOString().slice(0, 10);
  const row = await raw.get<{ sent: number }>(`SELECT sent FROM drip_days WHERE day = ?`, [yesterday]);
  assert.equal(row?.sent, 2, "yesterday's two land in yesterday's bucket, not today's");

  // Replay safety: MAX semantics mean re-running the seed cannot double-count.
  // Reach it directly, since the in-process single-flight guard will not run twice.
  await raw.run(`INSERT INTO drip_days (day, sent) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET sent = MAX(sent, excluded.sent)`, [yesterday, 2]);
  const again = await countDrips(NOW_MS);
  assert.equal(again?.allTime, 3, "a replayed seed must not inflate the count");
});
