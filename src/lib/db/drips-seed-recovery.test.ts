/**
 * A failed seed must not poison the counter for the life of the process.
 *
 * App's #324 finding: `seedOnce ??= seedDripDays(...)` caches a REJECTED promise,
 * so one transient ledger error made every later read return null until restart,
 * and because the seed is the one-time fold of retention's ~25h of survivors,
 * "until restart" could mean the survivors were purged unseeded: a transient
 * error permanently losing exactly the history the counter exists to preserve.
 *
 * Own process (own file) because the poison is per-process state, and the repro
 * needs the FIRST read to fail. Failure is induced by renaming drip_days away,
 * which makes the seed's own probe throw through the real driver; renaming it
 * back is the "transient error clears" half. CREATE TABLE IF NOT EXISTS only
 * runs at driver construction, so the rename sticks, a trap App hit twice
 * building the original repro.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-driprecover-")));
process.env.DB_BACKEND = "sqlite";

const { SqliteDriver } = await import("./driver.ts");

const NOW_MS = Date.parse("2026-08-02T12:00:00Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);

const raw = new SqliteDriver();
await raw.run(
  `INSERT INTO claims (address_hash, ip_hash, amount_zat, status, created_at) VALUES ('h', 'ip', 100, 'sent', ?)`,
  [NOW_SEC - 60],
);

const { countDrips, spendChallenge } = await import("./index.ts");

test("a transient seed failure recovers on the next read", async () => {
  // Construct the module's own driver FIRST, through an API that does not seed.
  // Its constructor re-runs CREATE TABLE IF NOT EXISTS, so a table renamed away
  // before construction would just be recreated and nothing would ever fail:
  // my first repro did exactly that and could not go red in either direction,
  // the same resurrect-on-construct trap App hit building theirs.
  await spendChallenge("sig-warmup", NOW_SEC + 60, NOW_SEC);

  // Now break a table the seed needs. claims, not drip_days: the seed's first
  // probe (any buckets?) must SUCCEED so the failure lands mid-seed, after the
  // point where a lazy implementation has already cached the promise.
  await raw.run(`ALTER TABLE claims RENAME TO claims_gone`, []);
  assert.equal(await countDrips(NOW_MS), null, "while broken, unknown rather than zero");

  await raw.run(`ALTER TABLE claims_gone RENAME TO claims`, []);
  const after = await countDrips(NOW_MS);
  assert.ok(after, "after the error clears, the counter must answer without a restart");
  assert.equal(after.allTime, 1, "and the survivor is seeded, not lost");
});
