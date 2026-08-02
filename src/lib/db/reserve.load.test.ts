import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { SCHEMA, RESERVE_SQL, FINALIZE_SQL, reserveParams } from "./sql.ts";

// The ledger half of issue #17: the daily cap and cooldown must hold no
// matter what happens at the PoW layer. PoW and the ledger are independent
// gates in the claim route (pow verifies first, then reserveClaim), so an
// attacker who solves every challenge honestly still cannot pass the cap.
// These tests run the real RESERVE_SQL against an in-memory database, which
// is the exact statement production executes, without the driver's fixed
// on-disk path.
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const DRIP = 50_000_000; // 0.5 TAZ per claim
const CAP = 100_000_000; // 1 TAZ per day, so exactly two drips fit
const COOLDOWN = 86_400;

function freshDb() {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

function reserve(db: InstanceType<typeof Database>, addr: string, ip: string, now: number) {
  return db.prepare(RESERVE_SQL).run(
    ...reserveParams({
      addressHash: addr,
      ipHash: ip,
      // "" is the skip sentinel for the subnet rule, so this file keeps testing the
      // cap and the per-IP cooldown under concurrency and nothing else.
      subnetHash: "",
      // Named rather than defaulted, because this file is about the per-IP cooldown
      // and the daily cap, and both of those are now network-scoped. A default here
      // would let a change to which network is default quietly move what is tested.
      network: "taz",
      amountZat: DRIP,
      now,
      cooldownSeconds: COOLDOWN,
      dailyCapZat: CAP,
      subnetDailyMax: 1_000_000,
    }),
  );
}

test("the daily cap blocks the claim that would cross it, whoever sends it", () => {
  const db = freshDb();
  const now = 1_800_000_000;

  const first = reserve(db, "addr-1", "ip-1", now);
  assert.equal(first.changes, 1, "first claim reserves");
  db.prepare(FINALIZE_SQL).run("sent", "tx-1", first.lastInsertRowid);

  const second = reserve(db, "addr-2", "ip-2", now + 10);
  assert.equal(second.changes, 1, "second claim fits the cap exactly");
  db.prepare(FINALIZE_SQL).run("sent", "tx-2", second.lastInsertRowid);

  // Third client: fresh address, fresh ip, nothing to escalate against, and
  // conceptually a perfectly solved PoW. The cap refuses anyway.
  const third = reserve(db, "addr-3", "ip-3", now + 20);
  assert.equal(third.changes, 0, "the cap holds regardless of pow");
});

test("pending reservations count against the cap, not just finalized sends", () => {
  const db = freshDb();
  const now = 1_800_000_000;

  // Two in-flight sends (reserved, not yet finalized) already fill the cap.
  assert.equal(reserve(db, "addr-1", "ip-1", now).changes, 1);
  assert.equal(reserve(db, "addr-2", "ip-2", now + 1).changes, 1);

  // A burst racer cannot slip a third claim in between reserve and send.
  assert.equal(reserve(db, "addr-3", "ip-3", now + 2).changes, 0);
});

test("cooldown blocks a repeat address and a repeat ip independently", () => {
  const db = freshDb();
  const now = 1_800_000_000;
  const first = reserve(db, "addr-1", "ip-1", now);
  assert.equal(first.changes, 1);
  db.prepare(FINALIZE_SQL).run("sent", "tx-1", first.lastInsertRowid);

  assert.equal(reserve(db, "addr-1", "ip-9", now + 30).changes, 0, "same address, new ip: blocked");
  assert.equal(reserve(db, "addr-9", "ip-1", now + 30).changes, 0, "new address, same ip: blocked");
  assert.equal(reserve(db, "addr-9", "ip-9", now + 30).changes, 1, "genuinely new client: allowed");
});

test("a concurrent burst for one address yields exactly one reservation", () => {
  const db = freshDb();
  const now = 1_800_000_000;

  // SQLite serializes writers and the statement is atomic, so N copies of the
  // same reserve can never all win. Model the burst as the serialized
  // interleaving the engine guarantees.
  let wins = 0;
  for (let i = 0; i < 25; i++) {
    if (reserve(db, "addr-hot", `ip-${i}`, now + i).changes === 1) wins++;
  }
  assert.equal(wins, 1, "one winner, 24 refused");

  const rows = db.prepare("SELECT COUNT(*) AS n FROM claims WHERE address_hash = ?").get("addr-hot") as { n: number };
  assert.equal(rows.n, 1, "and exactly one row exists");
});
