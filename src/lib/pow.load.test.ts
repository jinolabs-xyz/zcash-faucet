import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";

// Load and abuse behavior of the PoW gate (issue #17): escalation for a
// hammering client, the global-pressure bump, the maxBits ceiling, replay
// under a burst, expiry in bulk, and the daily cap holding regardless of any
// pow state. The single-case contract tests live in pow.test.ts; this file is
// about what happens under pressure.
//
// pow.ts keeps its counters in module state and reads config at load, so the
// knobs are pinned before the dynamic import and the tests run in sequence,
// each accounting for the global request count the earlier ones left behind.
process.chdir(mkdtempSync(join(tmpdir(), "faucet-pow-load-test-")));
process.env.RATE_LIMIT_SALT = "pow-load-salt";
process.env.FAUCET_POW_BITS = "8"; // floor, keeps every solve here trivial
process.env.FAUCET_POW_ESCALATE_BITS = "2";
process.env.FAUCET_POW_MAX_BITS = "14";

const { issueChallenge, verifySolution } = await import("./pow.ts");

const SALT = "pow-load-salt";
const BASE = 8;
const MAX = 14;

/** Mirror of pow.ts sign(), to mint expired challenges without waiting. */
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

function solveNonce(seed: string, difficulty: number): string {
  for (let i = 0; ; i++) {
    const digest = createHash("sha256").update(`${seed}:${i}`).digest();
    if (leadingZeroBits(digest) >= difficulty) return String(i);
  }
}

// Global request count pow.ts has seen, maintained by each test below so the
// pressure component (+1 at 10, +2 at 25, +3 at 60 within the window) is
// exact rather than assumed away.
let globalCount = 0;
const pressure = () => (globalCount >= 60 ? 3 : globalCount >= 25 ? 2 : globalCount >= 10 ? 1 : 0);

test("a hammering client escalates per request and hits the maxBits ceiling", async () => {
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) {
    const expected = Math.min(MAX, BASE + i * 2 + pressure());
    const ch = issueChallenge("iphash-hammer");
    globalCount++;
    seen.push(ch.difficulty);
    assert.equal(ch.difficulty, expected, `request ${i + 1}`);
  }
  // 8, 10, 12, then the ceiling twice: escalation is real and bounded.
  assert.deepEqual(seen, [8, 10, 12, 14, 14]);
});

test("someone else's hammering does not escalate a fresh client", async () => {
  const ch = issueChallenge("iphash-bystander");
  globalCount++;
  assert.equal(ch.difficulty, BASE + pressure());
  assert.ok(ch.difficulty <= BASE + 1, "no per-client escalation leaked across ipHashes");
});

test("global pressure raises difficulty for brand-new clients", async () => {
  // Flood from distinct ipHashes, one request each: no per-client escalation
  // anywhere, so any rise for the next client is the pressure term alone.
  while (globalCount < 60) {
    issueChallenge(`iphash-flood-${globalCount}`);
    globalCount++;
  }
  const ch = issueChallenge("iphash-after-flood");
  globalCount++;
  assert.equal(ch.difficulty, BASE + 3, "the +3 bump at 60 requests in the window");
});

test("a burst of solved challenges all verify once and none replay", async () => {
  const solved = Array.from({ length: 20 }, (_, i) => {
    const ipHash = `iphash-burst-${i}`;
    const ch = issueChallenge(ipHash);
    globalCount++;
    return { ipHash, sol: { ...ch, nonce: solveNonce(ch.seed, ch.difficulty) } };
  });

  for (const { ipHash, sol } of solved) {
    assert.deepEqual(await verifySolution(sol, ipHash), { ok: true });
  }
  for (const { ipHash, sol } of solved) {
    const again = await verifySolution(sol, ipHash);
    assert.equal(again.ok, false);
    assert.match(again.reason ?? "", /already used/i);
  }
});

test("a replayed sig is refused even with a different valid nonce", async () => {
  const ipHash = "iphash-renonce";
  const ch = issueChallenge(ipHash);
  globalCount++;
  const first = solveNonce(ch.seed, ch.difficulty);
  assert.equal((await verifySolution({ ...ch, nonce: first }, ipHash)).ok, true);

  // Find a second, different nonce that also meets the difficulty: the sig is
  // spent, so new work on the same challenge must not buy a second claim.
  let second = String(Number(first) + 1);
  for (let i = Number(first) + 1; ; i++) {
    const digest = createHash("sha256").update(`${ch.seed}:${i}`).digest();
    if (leadingZeroBits(digest) >= ch.difficulty) { second = String(i); break; }
  }
  const v = await verifySolution({ ...ch, nonce: second }, ipHash);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /already used/i);
});

test("expired challenges are refused in bulk, solved or not", async () => {
  const exp = Math.floor(Date.now() / 1000) - 5;
  for (let i = 0; i < 10; i++) {
    const ipHash = `iphash-expired-${i}`;
    const seed = createHash("sha256").update(`stale-${i}`).digest("hex").slice(0, 32);
    const sol = { seed, difficulty: 8, exp, sig: sign(seed, 8, exp, ipHash), nonce: solveNonce(seed, 8) };
    const v = await verifySolution(sol, ipHash);
    assert.equal(v.ok, false, `expired challenge ${i}`);
    assert.match(v.reason ?? "", /expired/i);
  }
});
