import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own file because config reads env once at module load and node --test
// gives every file its own process, which is the only clean way to exercise a
// different difficulty profile.
process.chdir(mkdtempSync(join(tmpdir(), "faucet-pow-escalation-")));
process.env.RATE_LIMIT_SALT = "escalation-test-salt";
process.env.FAUCET_POW_BITS = "8";
process.env.FAUCET_POW_ESCALATE_BITS = "2";
process.env.FAUCET_POW_MAX_BITS = "14";

const { issueChallenge, verifySolution } = await import("./pow.ts");

/**
 * One escalating attempt. A wrong nonce is enough: the counter is incremented
 * once the signature proves the challenge is ours, which is before the digest
 * is checked, so this exercises escalation without solving anything.
 */
async function attempt(ip: string) {
  const c = issueChallenge(ip);
  await verifySolution({ ...c, nonce: "not-a-solution" }, ip);
}

test("a hammering client is charged more work each ATTEMPT", async () => {
  const ip = "iphash-hammering";
  const bits: number[] = [];
  for (let i = 0; i < 3; i++) {
    bits.push(issueChallenge(ip).difficulty);
    await verifySolution({ ...issueChallenge(ip), nonce: "no" }, ip);
  }
  assert.deepEqual(bits, [8, 10, 12], "escalation should add the configured bits per recent attempt");
});

test("FETCHING a challenge never escalates, which was the #132 trap", async () => {
  // The 403 used to say refresh and try again, so a stuck user re-fetched, and
  // re-fetching raised the difficulty that had stuck them. Asking is free now.
  const ip = "iphash-only-fetches";
  const bits = [1, 2, 3, 4, 5].map(() => issueChallenge(ip).difficulty);
  assert.deepEqual(bits, [8, 8, 8, 8, 8], "a fetch must never be punishable");
});

test("escalation is per client, not global", async () => {
  // A fresh client pays the base rate even while someone else is attempting.
  // (Base can carry a small pressure bump once the faucet is busy, so this
  // asserts the gap, not an exact number.)
  await attempt("iphash-hammering");
  const fresh = issueChallenge("iphash-newcomer").difficulty;
  const hammered = issueChallenge("iphash-hammering").difficulty;
  assert.ok(fresh < hammered, `newcomer ${fresh} should be cheaper than hammerer ${hammered}`);
});

test("difficulty is capped so a phone never gets an unbounded wait", async () => {
  const ip = "iphash-relentless";
  for (let i = 0; i < 20; i++) await attempt(ip);
  assert.equal(issueChallenge(ip).difficulty, 14, "should sit at FAUCET_POW_MAX_BITS");
});
