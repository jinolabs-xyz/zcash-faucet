import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The point of this file: prove a spent challenge stays spent when the process
// dies. Everything runs against one real sqlite ledger in a throwaway dir, and
// a "restart" is a fresh module instance pointed at that same file.
const DIR = mkdtempSync(join(tmpdir(), "faucet-pow-durability-"));
process.chdir(DIR);
process.env.RATE_LIMIT_SALT = "durability-test-salt";
process.env.FAUCET_POW_BITS = "8";
process.env.FAUCET_POW_ESCALATE_BITS = "0";
process.env.DB_BACKEND = "sqlite";

const IP = "iphash-durability";

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
function findNonce(seed: string, difficulty: number): string {
  for (let i = 0; ; i++) {
    if (leadingZeroBits(createHash("sha256").update(`${seed}:${i}`).digest()) >= difficulty) return String(i);
  }
}

/**
 * Load a FRESH copy of the pow module, the way a restarted process would. The
 * cache-busting query gives a new module instance with empty in-memory state,
 * while the sqlite file on disk is the same one.
 */
let restarts = 0;
async function restart() {
  return import(`./pow.ts?restart=${restarts++}`);
}

test("a spent challenge is still spent after a restart", async () => {
  const first = await restart();
  const ch = first.issueChallenge(IP);
  const nonce = findNonce(ch.seed, ch.difficulty);
  assert.equal((await first.verifySolution({ ...ch, nonce }, IP)).ok, true, "first spend should succeed");

  // Process dies here. New module instance, empty memory, same ledger file.
  const second = await restart();
  const replay = await second.verifySolution({ ...ch, nonce }, IP);
  assert.equal(replay.ok, false, "restart handed back a live challenge");
  assert.match(replay.reason ?? "", /already used/i);
});

test("an unspent challenge still works after a restart", async () => {
  // The guard must not be so blunt that it eats valid challenges: one issued
  // before a restart and solved after it is legitimate and must go through.
  const before = await restart();
  const ch = before.issueChallenge(IP);
  const nonce = findNonce(ch.seed, ch.difficulty);

  const after = await restart();
  assert.equal((await after.verifySolution({ ...ch, nonce }, IP)).ok, true);
});

test("two racing verifications of one solution: exactly one wins", async () => {
  const mod = await restart();
  const ch = mod.issueChallenge(IP);
  const nonce = findNonce(ch.seed, ch.difficulty);

  const results = await Promise.all([
    mod.verifySolution({ ...ch, nonce }, IP),
    mod.verifySolution({ ...ch, nonce }, IP),
    mod.verifySolution({ ...ch, nonce }, IP),
  ]);
  assert.equal(results.filter((r: { ok: boolean }) => r.ok).length, 1, "the insert should be the mutex");
});

test("expired rows are pruned, so the table cannot grow forever", async () => {
  const { spendChallenge } = await import("./db/index.ts");
  const now = Math.floor(Date.now() / 1000);

  // A challenge that expired an hour ago, then a spend at "now" which triggers
  // the opportunistic purge.
  assert.equal(await spendChallenge("sig-long-expired", now - 3600, now - 3600), true);
  assert.equal(await spendChallenge("sig-live", now + 600, now), true);

  // The expired row is gone, so its sig is insertable again. That is safe: the
  // signature itself is past exp, so verifySolution rejects it before ever
  // reaching the ledger.
  assert.equal(await spendChallenge("sig-long-expired", now + 600, now), true, "expired row was not pruned");
  // The live one is still held.
  assert.equal(await spendChallenge("sig-live", now + 600, now), false, "live spend was pruned too early");
});
