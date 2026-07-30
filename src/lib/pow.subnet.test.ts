/**
 * Escalation keyed on the SUBNET as well as the address (#196).
 *
 * Its own file for the same reason pow.escalation.test.ts has one: config reads env
 * once at module load, and node --test gives each file its own process, which is the
 * only clean way to pin a difficulty profile.
 *
 * The lever this tests, and why it was the one worth landing. A cloud provider hands
 * one person thousands of addresses in a /24, so keying escalation on the address
 * alone meant 50 attempts from 50 addresses looked like 50 first-time users and the
 * farmer paid base difficulty forever. Residential users do not cluster that way,
 * which is the same reason the daily cap has been per-subnet since #220. This reuses
 * that fingerprint rather than adding a new identity notion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-pow-subnet-")));
process.env.RATE_LIMIT_SALT = "subnet-escalation-salt";
process.env.FAUCET_POW_BITS = "8";
process.env.FAUCET_POW_ESCALATE_BITS = "2";
process.env.FAUCET_POW_MAX_BITS = "20";

const { issueChallenge, verifySolution } = await import("./pow.ts");

/** One escalating attempt. A wrong nonce is enough: the counter increments once the
 *  signature proves the challenge is ours, before the digest is checked. */
async function attempt(ip: string, subnet: string | null) {
  const c = issueChallenge(ip, subnet);
  await verifySolution({ ...c, nonce: "not-a-solution" }, ip, subnet);
}

test("rotating addresses inside one range no longer resets difficulty", async () => {
  // The farmer's move, and the whole point of the change. Five attempts from five
  // distinct addresses in the same /24. Before this, each was a newcomer at 8 bits.
  const subnet = "subnet-cloud-range";
  for (let i = 0; i < 5; i++) await attempt(`ip-rotating-${i}`, subnet);

  const sixth = issueChallenge("ip-rotating-fresh", subnet).difficulty;
  assert.ok(sixth > 8, `a sixth address in the same range still paid base difficulty (${sixth})`);
  assert.equal(sixth, 8 + 5 * 2, "should be base plus one escalation step per attempt in the range");
});

test("a first-time claimer in a quiet range still pays the base, so this cost them nothing", async () => {
  // The constraint every lever here is judged against. If this moves, we have started
  // taxing honest users instead of the farmer.
  assert.equal(issueChallenge("ip-honest", "subnet-quiet-residential").difficulty, 8);
});

test("one address hammering is not charged TWICE for the same attempts", async () => {
  // MAX rather than sum. Both buckets see the same attempt when a single address makes
  // it, so summing would double every honest repeat-user's escalation to buy nothing.
  const ip = "ip-single-hammerer";
  const subnet = "subnet-single-hammerer";
  for (let i = 0; i < 3; i++) await attempt(ip, subnet);

  const next = issueChallenge(ip, subnet).difficulty;
  assert.equal(next, 8 + 3 * 2, `three attempts should cost three steps, not six (got ${next})`);
});

test("an unparseable IP has no subnet and is simply exempt from the range rule", async () => {
  // Same choice as the daily cap: skip the rule rather than drop every unparseable
  // client into one shared bucket, which would make them escalate each other.
  for (let i = 0; i < 4; i++) await attempt(`ip-nosubnet-${i}`, null);
  assert.equal(issueChallenge("ip-nosubnet-fresh", null).difficulty, 8);
});

test("ranges do not leak into each other", async () => {
  // Otherwise one busy cloud range would raise difficulty for every other network,
  // which is the global-pressure lever's job and not this one's.
  for (let i = 0; i < 4; i++) await attempt(`ip-busy-${i}`, "subnet-busy");
  assert.equal(issueChallenge("ip-elsewhere", "subnet-elsewhere").difficulty, 8);
});

test("an unsigned attempt cannot escalate a whole range", async () => {
  // This property existed for one address and matters far more now: if a junk POST
  // could increment the range counter, anyone could raise difficulty for an entire
  // /24 they do not belong to, including a shared office or university. The counter
  // is incremented only after the signature proves we issued the challenge.
  const subnet = "subnet-victim";
  const forged = { seed: "deadbeef", difficulty: 8, exp: Math.floor(Date.now() / 1000) + 600, sig: "not-our-signature", nonce: "x" };
  for (let i = 0; i < 6; i++) await verifySolution(forged, `ip-attacker-${i}`, subnet);

  assert.equal(
    issueChallenge("ip-victim", subnet).difficulty,
    8,
    "forged POSTs escalated a range the attacker does not belong to",
  );
});
