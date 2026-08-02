/**
 * WHICH LIMITS SPLIT BY NETWORK AND WHICH DO NOT (#326).
 *
 * Two of the four do and two do not, and the file exists because the asymmetry is the
 * thing a later change is most likely to "tidy up" into consistency:
 *
 *   address cooldown  PER NETWORK   different chains, different money
 *   daily cap         PER NETWORK   a drain guard, and they are different wallets
 *   ip cap            GLOBAL        anti-abuse, and splitting it doubles a farmer's take
 *   subnet cap        GLOBAL        same
 *
 * The last two carry the real risk. Making them per-network would look like finishing
 * the job and would hand anyone who can flip a toggle twice the budget, using a lever
 * we built. Both directions are asserted here: the ones that split, and the ones that
 * must not.
 *
 * Driven through RESERVE_SQL against a real in-memory sqlite, like subnetCap.test.ts,
 * so what is tested is the statement that actually runs rather than a description of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { RESERVE_SQL, reserveParams, SCHEMA } from "./sql.ts";

const Database = createRequire(import.meta.url)("better-sqlite3");

const NOW = 1_800_000_000;
const COOLDOWN = 86_400;
const DRIP = 10_000_000;
/** Room for ten drips, so a cap test has to arrange the overflow deliberately. */
const CAP = DRIP * 10;

function db() {
  const d = new Database(":memory:");
  d.exec(SCHEMA);
  return d;
}

type Opts = { subnet?: string; network?: string; cap?: number; amount?: number; at?: number };

function claim(d: InstanceType<typeof Database>, addr: string, ip: string, o: Opts = {}): boolean {
  const r = d.prepare(RESERVE_SQL).run(
    ...reserveParams({
      addressHash: addr,
      ipHash: ip,
      subnetHash: o.subnet ?? "",
      amountZat: o.amount ?? DRIP,
      now: o.at ?? NOW,
      cooldownSeconds: COOLDOWN,
      dailyCapZat: o.cap ?? CAP,
      subnetDailyMax: 2,
      network: o.network ?? "taz",
    }),
  );
  // Mark it sent, so it blocks for the full cooldown rather than the short lease.
  if (r.changes === 1) d.prepare("UPDATE claims SET status='sent' WHERE id = ?").run(r.lastInsertRowid);
  return r.changes === 1;
}

test("THE ADDRESS COOLDOWN SPLITS: one address can claim on both networks", () => {
  const d = db();
  assert.equal(claim(d, "addr-1", "ip-1", { network: "taz" }), true);
  assert.equal(claim(d, "addr-1", "ip-2", { network: "taz" }), false, "same address, same network, must be blocked");
  assert.equal(
    claim(d, "addr-1", "ip-3", { network: "ctaz" }),
    true,
    "trying the feature net must not cost someone their TAZ drip",
  );
});

test("and it still holds WITHIN a network, so the split did not disable the cooldown", () => {
  // The failure mode of getting this wrong in the generous direction: scope the check
  // so narrowly that nothing blocks. Without this, the test above passes on a build
  // with no address cooldown at all.
  const d = db();
  assert.equal(claim(d, "addr-2", "ip-1", { network: "ctaz" }), true);
  assert.equal(claim(d, "addr-2", "ip-2", { network: "ctaz" }), false);
});

test("THE DAILY CAP SPLITS: a busy cTAZ day does not close the TAZ faucet", () => {
  const d = db();
  // Fill cTAZ exactly to its cap with distinct addresses and IPs, so nothing but the
  // cap can be doing the blocking.
  for (let i = 0; i < 10; i++) {
    assert.equal(claim(d, `c-addr-${i}`, `c-ip-${i}`, { network: "ctaz" }), true, `cTAZ claim ${i}`);
  }
  assert.equal(claim(d, "c-addr-x", "c-ip-x", { network: "ctaz" }), false, "the cTAZ cap should now be full");
  assert.equal(
    claim(d, "t-addr-1", "t-ip-1", { network: "taz" }),
    true,
    "TAZ has its own wallet and its own cap, and neither was touched",
  );
});

test("THE IP CAP STAYS GLOBAL, so the toggle is not a doubling device", () => {
  // The one that matters. If this ever goes red because someone made it per network,
  // the change handed every farmer twice the take from one address range.
  const d = db();
  assert.equal(claim(d, "addr-a", "shared-ip", { network: "taz" }), true);
  assert.equal(
    claim(d, "addr-b", "shared-ip", { network: "ctaz" }),
    false,
    "one client must not get a second drip by switching networks",
  );
});

test("THE SUBNET CAP STAYS GLOBAL, and counts across both networks", () => {
  // subnetDailyMax is 2 here. Two claims from one subnet exhaust it whatever mix of
  // networks they were on, and the third is refused.
  const d = db();
  assert.equal(claim(d, "s-addr-1", "s-ip-1", { subnet: "net-1", network: "taz" }), true);
  assert.equal(claim(d, "s-addr-2", "s-ip-2", { subnet: "net-1", network: "ctaz" }), true);
  assert.equal(
    claim(d, "s-addr-3", "s-ip-3", { subnet: "net-1", network: "taz" }),
    false,
    "the subnet budget is per person-ish, not per network, and two networks spend two slots",
  );
});

test("a legitimate two-network user DOES spend two subnet slots, and that is the chosen cost", () => {
  // Stated as its own case rather than left implicit in the test above, because it is
  // the price of keeping those caps global and it should be visible when someone
  // wonders why an honest user hit a limit. Same subnet, same person, two chains.
  const d = db();
  assert.equal(claim(d, "me-taz", "my-ip", { subnet: "home", network: "taz" }), true);
  assert.equal(claim(d, "me-ctaz", "other-ip", { subnet: "home", network: "ctaz" }), true);
  const n = (d.prepare("SELECT COUNT(*) AS n FROM claims WHERE subnet_hash = 'home'").get() as { n: number }).n;
  assert.equal(n, 2, "both claims count against the one subnet budget");
});

test("the network is RECORDED, not just used to decide", () => {
  // The column has to hold the value, or the drip counter and any later question about
  // which chain a claim was on is answering from nothing.
  const d = db();
  claim(d, "rec-1", "rec-ip-1", { network: "ctaz" });
  claim(d, "rec-2", "rec-ip-2", { network: "taz" });
  const rows = d.prepare("SELECT address_hash, network FROM claims ORDER BY id").all() as {
    address_hash: string; network: string;
  }[];
  assert.deepEqual(rows, [
    { address_hash: "rec-1", network: "ctaz" },
    { address_hash: "rec-2", network: "taz" },
  ]);
});

test("a row written without a network defaults to taz, which is what those rows were", () => {
  // Matches the migration's DEFAULT. Every claim that predates the toggle was TAZ, so
  // this records history rather than guessing at it.
  const d = db();
  d.prepare(
    "INSERT INTO claims (address_hash, ip_hash, amount_zat, status, created_at) VALUES (?,?,?,?,?)",
  ).run("legacy", "legacy-ip", DRIP, "sent", NOW);
  const row = d.prepare("SELECT network FROM claims WHERE address_hash = 'legacy'").get() as { network: string };
  assert.equal(row.network, "taz");
  // And it blocks a TAZ claim, so historic cooldowns are not released by the new column.
  assert.equal(claim(d, "legacy", "another-ip", { network: "taz" }), false);
});
