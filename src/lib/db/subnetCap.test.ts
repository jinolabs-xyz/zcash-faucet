/**
 * The per-subnet daily cap (#196), against a real ledger through the shipped SQL.
 *
 * What this is FOR. Addresses are free, so the per-address cooldown costs a farmer
 * nothing. IPs cost money but come in blocks, so the per-IP cooldown means a /24
 * permits 256 claims a day. This is the rule that makes a block of cloud IPs cost
 * what a block of cloud IPs should, and it is the only one of our limits that a
 * residential claimer will never meet.
 *
 * The three properties worth pinning are that it BLOCKS a farm inside one subnet,
 * that it does NOT touch a claimer in a different subnet, and that it is skipped
 * rather than shared when the subnet is unknown. The last one matters most: a
 * fallback bucket for unparseable clients would make real users block each other,
 * which is a worse outcome than the farming it would prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3");

process.chdir(mkdtempSync(join(tmpdir(), "faucet-subnet-cap-")));
process.env.RATE_LIMIT_SALT = "subnet-cap-salt";

const { SCHEMA, RESERVE_SQL, reserveParams } = await import("./sql.ts");

const NOW = 1_800_000_000;
const COOLDOWN = 86_400;
const DRIP = 10_000_000;
const CAP = 100_000_000_000;
const SUBNET_MAX = 3; // small, so the boundary is legible

function freshDb() {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

/** One reservation attempt. Returns true when a row was inserted. */
function claim(
  db: InstanceType<typeof Database>,
  addr: string,
  ip: string,
  subnet: string,
  at = NOW,
): boolean {
  const r = db.prepare(RESERVE_SQL).run(
    ...reserveParams({
      addressHash: addr,
      ipHash: ip,
      subnetHash: subnet,
      // The subnet cap is GLOBAL, so every claim here is on one network deliberately:
      // splitting them would be testing a rule this cap does not have.
      network: "taz",
      amountZat: DRIP,
      now: at,
      cooldownSeconds: COOLDOWN,
      dailyCapZat: CAP,
      subnetDailyMax: SUBNET_MAX,
    }),
  );
  return r.changes === 1;
}

test("a farm inside ONE subnet is cut off at the cap", () => {
  // Every claim uses a fresh address and a fresh IP, so neither the per-address nor
  // the per-IP rule can be what stops it. Only the subnet rule can.
  const db = freshDb();
  for (let i = 0; i < SUBNET_MAX; i++) {
    assert.equal(claim(db, `addr-${i}`, `ip-${i}`, "subnet-A"), true, `claim ${i} should succeed`);
  }
  assert.equal(claim(db, "addr-over", "ip-over", "subnet-A"), false, "the claim past the cap must be refused");
});

test("a claimer in a DIFFERENT subnet is untouched by that farm", () => {
  // The property that decides whether this is a defence or an outage. If one busy
  // subnet could exhaust anything shared, we would have built a denial-of-service.
  const db = freshDb();
  for (let i = 0; i < SUBNET_MAX + 5; i++) claim(db, `addr-a-${i}`, `ip-a-${i}`, "subnet-A");
  assert.equal(claim(db, "addr-b", "ip-b", "subnet-B"), true, "an unrelated subnet must still be served");
});

test("an UNKNOWN subnet skips the rule rather than sharing a bucket", () => {
  // "" is the skip sentinel. Many unparseable clients must not accumulate against
  // each other: that would make real users block real users, which is worse than
  // the farm this rule exists to stop.
  const db = freshDb();
  for (let i = 0; i < SUBNET_MAX + 5; i++) {
    assert.equal(claim(db, `addr-u-${i}`, `ip-u-${i}`, ""), true, `unknown-subnet claim ${i} must not be capped`);
  }
});

test("the per-address cooldown still bites inside the cap, so nothing was loosened", () => {
  // Adding a rule must not have weakened one. Same address twice, well under the
  // subnet cap, must still be refused.
  const db = freshDb();
  assert.equal(claim(db, "addr-same", "ip-1", "subnet-C"), true);
  assert.equal(claim(db, "addr-same", "ip-2", "subnet-C"), false, "the address cooldown must still apply");
});

test("the per-IP cooldown still bites too", () => {
  const db = freshDb();
  assert.equal(claim(db, "addr-x", "ip-same", "subnet-D"), true);
  assert.equal(claim(db, "addr-y", "ip-same", "subnet-D"), false, "the IP cooldown must still apply");
});

test("the window rolls: claims older than 24h stop counting toward the subnet", () => {
  const db = freshDb();
  const old = NOW - 86_400 - 60; // just outside
  for (let i = 0; i < SUBNET_MAX; i++) claim(db, `addr-old-${i}`, `ip-old-${i}`, "subnet-E", old);
  assert.equal(
    claim(db, "addr-new", "ip-new", "subnet-E"),
    true,
    "a subnet at its cap yesterday must not be blocked today",
  );
});

test("historic rows with a NULL subnet_hash never match, so a migrated ledger is not pre-loaded", () => {
  // Rows written before the column existed have NULL, and `subnet_hash = ?` is never
  // true for NULL. If that were not so, every old claim would count against whichever
  // subnet asked first after the migration (#213).
  const db = freshDb();
  for (let i = 0; i < 50; i++) {
    db.prepare(
      "INSERT INTO claims (address_hash, ip_hash, subnet_hash, amount_zat, status, created_at) VALUES (?,?,NULL,?,?,?)",
    ).run(`addr-hist-${i}`, `ip-hist-${i}`, DRIP, "sent", NOW - 100);
  }
  assert.equal(claim(db, "addr-after", "ip-after", "subnet-F"), true, "NULL rows must not count against any subnet");
});
