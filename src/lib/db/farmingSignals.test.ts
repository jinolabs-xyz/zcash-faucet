/**
 * The farming-visibility read (#196), against a real SQLite ledger.
 *
 * Its own file with its own scratch cwd, because the ledger is
 * `$cwd/data/faucet.db` with no override and every test that writes a claim shares
 * it (rule 14). Asserted through the shipped `farmingSignals()` and the shipped SQL,
 * never a reimplementation of the counting, because a copy of the query would pass
 * while the real one broke (rule 15).
 *
 * The signal that matters is claims per DISTINCT ip_hash. One claim per IP is what
 * honest use looks like. Many claims from few IPs is a farm or a shared NAT. Many
 * IPs claiming once each is either healthy growth or a distributed farm, and that
 * ambiguity is what the subnet column will resolve once #213 unblocks it.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-farming-signals-")));
process.env.RATE_LIMIT_SALT = "farming-signals-salt";

const { farmingSignals } = await import("./index.ts");
const { SqliteDriver } = await import("./driver.ts");

const NOW = Math.floor(Date.now() / 1000);
const TAZ = 100_000_000;

/**
 * Insert claims directly. Going through reserveClaim would enforce the cooldown and
 * make it impossible to CREATE the farming shape this read exists to detect, which
 * is the point: the ledger can hold rows the current gates would refuse, because the
 * gates changed after the rows were written.
 */
let driver: InstanceType<typeof SqliteDriver>;
async function claim(ipHash: string, addressHash: string, ageSeconds: number, status = "sent") {
  await driver.run(
    "INSERT INTO claims (address_hash, ip_hash, amount_zat, status, created_at) VALUES (?,?,?,?,?)",
    [addressHash, ipHash, 0.1 * TAZ, status, NOW - ageSeconds],
  );
}

before(async () => {
  driver = new SqliteDriver();
  await driver.run("SELECT 1", []); // force the lazy open so SCHEMA has run
  // A farm: 40 claims from 3 IPs inside the hour, each to a fresh address.
  for (let i = 0; i < 40; i++) await claim(`ip-farm-${i % 3}`, `addr-farm-${i}`, 60 + i);
  // Honest use: 5 people, one claim each, inside the hour.
  for (let i = 0; i < 5; i++) await claim(`ip-real-${i}`, `addr-real-${i}`, 120 + i);
  // Older than 24h, so it must not appear in either window.
  await claim("ip-ancient", "addr-ancient", 90_000);
  // A failed claim, which is not a payout and must not be counted.
  await claim("ip-failed", "addr-failed", 300, "failed");
});

test("counts claims and distinct identities over the hour, excluding failures", async () => {
  const s = await farmingSignals(NOW);
  assert.ok(s, "the read returned null, so nothing below means anything");
  assert.equal(s.claims1h, 45, "40 farm + 5 honest, and NOT the failed one");
  assert.equal(s.distinctIps1h, 8, "3 farm IPs + 5 honest IPs");
  assert.equal(s.distinctAddrs1h, 45, "every claim used a fresh address, which is the cheap part");
});

test("the ratio is the signal, and it is what a farm actually moves", async () => {
  const s = await farmingSignals(NOW);
  assert.ok(s);
  // 45 claims over 8 IPs. Honest use alone would be 1.0.
  assert.ok(s.claimsPerIp24h !== null);
  assert.ok(
    s.claimsPerIp24h > 5,
    `claims per IP is ${s.claimsPerIp24h?.toFixed(2)}, which would not look like a farm`,
  );
});

test("distinct ADDRESSES rising while distinct IPS does not is the farming shape", async () => {
  // The thing worth alerting on. Addresses are free and unlimited, IPs cost money,
  // so a farm shows up as the two diverging. This is the comparison an operator
  // should be looking at and it is why both are reported rather than just a count.
  const s = await farmingSignals(NOW);
  assert.ok(s);
  assert.ok(
    s.distinctAddrs1h > s.distinctIps1h * 4,
    `${s.distinctAddrs1h} addresses over ${s.distinctIps1h} IPs does not show the divergence`,
  );
});

test("the 24h window includes the hour and still excludes what predates it", async () => {
  const s = await farmingSignals(NOW);
  assert.ok(s);
  assert.equal(s.claims24h, 45, "the 90,000s-old claim is outside 24h and must not appear");
  assert.equal(s.distinctIps24h, 8);
});

test("TAZ is summed as TAZ, not left as zatoshi", async () => {
  const s = await farmingSignals(NOW);
  assert.ok(s);
  // 45 claims at 0.1 each. A zatoshi/TAZ mixup here would report 450,000,000.
  assert.ok(Math.abs(s.taz1h - 4.5) < 1e-9, `taz1h is ${s.taz1h}, expected 4.5`);
});

test("an empty window reports a NULL ratio, never Infinity or NaN", async () => {
  // A ratio with no denominator is an absent number, not a large one. Reporting
  // Infinity here would render as a value and read as a catastrophic farm.
  //
  // The window is cut-and-newer with NO upper bound, so an empty one is a cut that
  // postdates every row rather than a `now` in the past. My first version passed
  // NOW-200_000 expecting an empty window and got everything: moving `now` back
  // WIDENS the window instead of shifting it. Correct for the only real caller,
  // where `now` is the current time, and worth knowing before writing an assertion
  // against it.
  const s = await farmingSignals(NOW + 200_000);
  assert.ok(s);
  assert.equal(s.distinctIps24h, 0);
  assert.equal(s.claimsPerIp24h, null);
});
