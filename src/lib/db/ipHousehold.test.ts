/**
 * The per-IP allowance, against a real ledger through the shipped SQL.
 *
 * WHY IT IS NOT ONE. Until 2026-09-11 the gate was `NOT EXISTS (... ip_hash ...)`, so one
 * drip per IP per day. Every laptop and phone behind a home router shares one public
 * address, which made that one drip per HOUSEHOLD. It was reported twice in a day: a
 * forum user who claimed, retried from the same connection and read the refusal as the
 * faucet being down, and the owner, whose family share a Wi-Fi.
 *
 * WHY IT IS STILL KEYED ON THE IP. The alternative is identifying devices, and a device
 * is either a cookie - cleared in one click, and incognito never had it - or a
 * fingerprint, which is durable, still bypassable by anyone motivated, and would make
 * "it calls nobody and tracks nobody" untrue. A looser IP rule costs a farmer N drips
 * instead of one. A fingerprint costs the project the reason people trust it.
 *
 * The address rule is still one per day, the subnet cap still bounds a whole range, and
 * proof-of-work is still paid per claim, so this is the only limit that moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3");

process.chdir(mkdtempSync(join(tmpdir(), "faucet-ip-household-")));
process.env.RATE_LIMIT_SALT = "ip-household-salt";

const { SCHEMA, RESERVE_SQL, reserveParams } = await import("./sql.ts");

const NOW = 1_800_000_000;
const COOLDOWN = 86_400;
const DRIP = 10_000_000;
const CAP = 100_000_000_000;
const IP_MAX = 3; // small, so the boundary is legible

function freshDb() {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

function claim(
  db: InstanceType<typeof Database>,
  addr: string,
  ip: string,
  at = NOW,
  ipDailyMax = IP_MAX,
): boolean {
  const r = db.prepare(RESERVE_SQL).run(
    ...reserveParams({
      pendingLeaseSeconds: 120,
      addressHash: addr,
      ipHash: ip,
      // "" skips the subnet rule, so only the IP rule can be what blocks here.
      subnetHash: "",
      network: "taz",
      amountZat: DRIP,
      now: at,
      cooldownSeconds: COOLDOWN,
      dailyCapZat: CAP,
      ipDailyMax,
      subnetDailyMax: 999,
    }),
  );
  // MARKED SENT, because that is what a paid drip is. A row left 'pending' only blocks
  // for the lease (120s here), so a test that never finalises is measuring the lease and
  // not the cooldown - which is exactly how the ageing case below first passed for the
  // wrong reason and then failed for the right one.
  if (r.changes === 1) db.prepare("UPDATE claims SET status='sent', txid='tx' WHERE id = ?").run(r.lastInsertRowid);
  return r.changes === 1;
}

test("a HOUSEHOLD behind one IP gets a drip each, up to the allowance", () => {
  // The defect, in one test: three devices, three different addresses, one router.
  const db = freshDb();
  for (let i = 0; i < IP_MAX; i++) {
    assert.equal(claim(db, `device-${i}`, "home-ip"), true, `device ${i} should have been paid`);
  }
  // And the allowance is a real ceiling, not an absence of one.
  assert.equal(claim(db, "device-4", "home-ip"), false, "the fourth must be refused");
});

test("ONE address is still one drip a day, however many the connection has left", () => {
  // The per-address rule did not move. Loosening the IP rule must not loosen this one:
  // otherwise the same address could take the whole household allowance by itself.
  const db = freshDb();
  assert.equal(claim(db, "same-address", "home-ip"), true);
  assert.equal(claim(db, "same-address", "home-ip"), false, "the same address must not claim twice");
  // A different address on the same connection still works, which is the whole point.
  assert.equal(claim(db, "other-address", "home-ip"), true);
});

test("the allowance is per connection, so one house cannot spend another's", () => {
  const db = freshDb();
  for (let i = 0; i < IP_MAX; i++) assert.equal(claim(db, `a-${i}`, "house-a"), true);
  assert.equal(claim(db, "a-spill", "house-a"), false, "house A is out");
  assert.equal(claim(db, "b-1", "house-b"), true, "house B is untouched");
});

test("a slot frees when the OLDEST claim ages out, not the newest", () => {
  // With N per window the next opening is the expiry of the earliest claim. Measuring
  // from the latest would tell a household to come back a day after their LAST attempt,
  // which is a refusal that never expires while anyone keeps trying.
  const db = freshDb();
  assert.equal(claim(db, "d-1", "home-ip", NOW), true);
  assert.equal(claim(db, "d-2", "home-ip", NOW + 3600), true);
  assert.equal(claim(db, "d-3", "home-ip", NOW + 7200), true);
  assert.equal(claim(db, "d-4", "home-ip", NOW + 7300), false, "full while all three are live");
  // One second after the FIRST claim ages out, a slot exists - even though the third
  // claim is only two hours old.
  assert.equal(claim(db, "d-4", "home-ip", NOW + COOLDOWN + 1), true);
});

test("ipDailyMax of 1 restores the old rule exactly", () => {
  // The knob has to be able to put it back, or a bad outcome cannot be reverted without
  // a deploy of new code.
  const db = freshDb();
  assert.equal(claim(db, "first", "home-ip", NOW, 1), true);
  assert.equal(claim(db, "second", "home-ip", NOW, 1), false);
});
