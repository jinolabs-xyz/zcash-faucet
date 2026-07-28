import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pow.ts reads RATE_LIMIT_SALT and the difficulty knobs at module load, so pin
// them before the dynamic import. Fixed salt makes signing deterministic. 8
// bits (the floor) keeps the brute-force solve to ~256 hashes, and escalation
// off keeps difficulty stable however many challenges this file issues.
// verifySolution now spends challenges in the ledger, and SqliteDriver opens
// data/faucet.db under the CWD, so run in a throwaway dir instead of seeding a
// database into the repo.
process.chdir(mkdtempSync(join(tmpdir(), "faucet-pow-test-")));
process.env.RATE_LIMIT_SALT = "pow-test-salt";
process.env.FAUCET_POW_BITS = "8";
process.env.FAUCET_POW_ESCALATE_BITS = "0";

const { issueChallenge, verifySolution } = await import("./pow.ts");

const SALT = "pow-test-salt";
const IP = "iphash-test-client";

/** Mirror of pow.ts sign(), so tests can mint their own signed challenges. */
function sign(seed: string, difficulty: number, exp: number, ipHash: string): string {
  return createHmac("sha256", SALT).update(`${seed}.${difficulty}.${exp}.${ipHash}`).digest("hex");
}

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    for (let m = 0x80; m > 0; m >>= 1) {
      if (byte & m) return bits;
      bits++;
    }
    return bits;
  }
  return bits;
}

/** Brute-force a nonce meeting (or, inverted, failing) the difficulty. */
function findNonce(seed: string, difficulty: number, meet = true): string {
  for (let i = 0; ; i++) {
    const digest = createHash("sha256").update(`${seed}:${i}`).digest();
    const ok = leadingZeroBits(digest) >= difficulty;
    if (ok === meet) return String(i);
  }
}

test("issueChallenge: shape, expiry window, and a signature we can reproduce", async () => {
  const before = Math.floor(Date.now() / 1000);
  const ch = issueChallenge(IP);

  assert.match(ch.seed, /^[0-9a-f]{32}$/);
  assert.equal(ch.difficulty, 8); // baseBits, no escalation, no pressure yet
  // exp = issue time + ttl (default 180s), allowing a second of clock movement
  assert.ok(ch.exp >= before + 179 && ch.exp <= before + 181, `exp ${ch.exp} not ~${before}+180`);
  assert.equal(ch.sig, sign(ch.seed, ch.difficulty, ch.exp, IP));
});

test("accepts a correctly solved challenge", async () => {
  const ch = issueChallenge(IP);
  const nonce = findNonce(ch.seed, ch.difficulty);
  assert.deepEqual(await verifySolution({ ...ch, nonce }, IP), { ok: true });
});

test("rejects a tampered signature", async () => {
  const ch = issueChallenge(IP);
  const nonce = findNonce(ch.seed, ch.difficulty);
  const sig = (ch.sig[0] === "0" ? "1" : "0") + ch.sig.slice(1);
  const v = await verifySolution({ ...ch, sig, nonce }, IP);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /signature/i);
});

test("rejects a solution presented from a different ipHash", async () => {
  const ch = issueChallenge(IP);
  const nonce = findNonce(ch.seed, ch.difficulty);
  // The sig binds the ipHash, so a stolen solution fails the signature check.
  const v = await verifySolution({ ...ch, nonce }, "iphash-someone-else");
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /signature/i);
});

test("rejects an expired challenge", async () => {
  const exp = Math.floor(Date.now() / 1000) - 10;
  const seed = "00".repeat(16);
  const ch = { seed, difficulty: 8, exp, sig: sign(seed, 8, exp, IP) };
  const v = await verifySolution({ ...ch, nonce: findNonce(seed, 8) }, IP);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /expired/i);
});

test("rejects difficulty outside the configured bounds", async () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const seed = "11".repeat(16);
  // Even correctly signed, a difficulty the server would never issue is refused:
  // below baseBits-1 (downgraded challenge) or above maxBits (default 26).
  for (const difficulty of [6, 27]) {
    const ch = { seed, difficulty, exp, sig: sign(seed, difficulty, exp, IP) };
    const v = await verifySolution({ ...ch, nonce: "0" }, IP);
    assert.equal(v.ok, false, `difficulty ${difficulty} should be rejected`);
    assert.match(v.reason ?? "", /difficulty/i);
  }
});

test("rejects a nonce that misses the required leading zero bits", async () => {
  const ch = issueChallenge(IP);
  const nonce = findNonce(ch.seed, ch.difficulty, false);
  const v = await verifySolution({ ...ch, nonce }, IP);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /does not meet/i);
});

test("rejects a replayed challenge: each sig is single-use", async () => {
  const ch = issueChallenge(IP);
  const nonce = findNonce(ch.seed, ch.difficulty);
  assert.equal((await verifySolution({ ...ch, nonce }, IP)).ok, true);
  const again = await verifySolution({ ...ch, nonce }, IP);
  assert.equal(again.ok, false);
  assert.match(again.reason ?? "", /already used/i);
});

test("rejects a missing or fieldless solution", async () => {
  // @ts-expect-error deliberately malformed
  assert.equal((await verifySolution({}, IP)).ok, false);
  const ch = issueChallenge(IP);
  // @ts-expect-error nonce absent
  assert.equal((await verifySolution({ ...ch }, IP)).ok, false);
});
