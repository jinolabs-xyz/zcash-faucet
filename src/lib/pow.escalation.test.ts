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

const { issueChallenge } = await import("./pow.ts");

test("a hammering client is charged more work each time", () => {
  const ip = "iphash-hammering";
  const bits = [issueChallenge(ip), issueChallenge(ip), issueChallenge(ip)].map((c) => c.difficulty);
  assert.deepEqual(bits, [8, 10, 12], "escalation should add the configured bits per recent request");
});

test("escalation is per client, not global", () => {
  // A fresh client pays the base rate even while someone else is hammering.
  // (Base can carry a small pressure bump once the faucet is busy, so this
  // asserts the gap, not an exact number.)
  const fresh = issueChallenge("iphash-newcomer").difficulty;
  const hammered = issueChallenge("iphash-hammering").difficulty;
  assert.ok(fresh < hammered, `newcomer ${fresh} should be cheaper than hammerer ${hammered}`);
});

test("difficulty is capped so a phone never gets an unbounded wait", () => {
  const ip = "iphash-relentless";
  let last = 0;
  for (let i = 0; i < 20; i++) last = issueChallenge(ip).difficulty;
  assert.equal(last, 14, "should sit at FAUCET_POW_MAX_BITS");
});
