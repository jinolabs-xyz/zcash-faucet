/**
 * The cache exists because no request-path timeout survives the node's latency: measured
 * 20ms to 30s on consecutive calls, the RPC thread starved by the node's own miner. These
 * pin the properties that make a cache safe on a money-adjacent path, against the real
 * reader and a real socket.
 */
import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ctaz-cache-"));
const SOCK = join(dir, "rpc.sock");

process.env.FAUCET_CTAZ_ENABLED = "true";
process.env.FAUCET_CTAZ_RPC_SOCKET = SOCK;
process.env.CROSSLINK_RPC_URL = "";
process.env.FAUCET_CTAZ_STATUS_FILE = join(dir, "no-such-file.json");

const { cachedCtazNodeState, refreshCtazStateForTests, resetCtazStateCacheForTests, MAX_CACHE_AGE_MS } =
  await import("./cache.ts");

let server: Server | null = null;
function serveBroker(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer({ allowHalfOpen: true }, (conn) => {
      let raw = "";
      conn.on("data", (d) => (raw += d));
      conn.on("end", () => {
        const req = JSON.parse(raw) as { id: number; method: string };
        const result =
          req.method === "get_tfl_recency_status"
            ? {
                now_utc: Math.floor(Date.now() / 1000) - 5,
                my_height: 300_000,
                my_round: 12,
                my_locked_round: 11,
                finalizer_statuses: Array.from({ length: 46 }, () => ({})),
              }
            : { blocks: 300_000, estimatedheight: 300_001, headers: 300_001 };
        conn.end(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
      });
    });
    server.listen(SOCK, resolve);
  });
}
function stopBroker(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = null;
    rmSync(SOCK, { force: true });
  });
}

afterEach(() => resetCtazStateCacheForTests());
after(async () => {
  await stopBroker();
  rmSync(dir, { recursive: true, force: true });
});

test("a cold cache is cannot-verify, never a block on the node", () => {
  // The first request after boot must not wait for the socket. cannot-verify is what the
  // page said before the node was ever asked, and the gate refuses it, which is correct
  // until a real answer exists.
  const s = cachedCtazNodeState();
  assert.equal(s.source, "none");
  assert.equal(s.reading.state, "cannot-verify");
});

test("after one refresh the cache serves the node's answer from memory", async () => {
  await serveBroker();
  await refreshCtazStateForTests();
  const s = cachedCtazNodeState();
  assert.equal(s.source, "rpc");
  assert.equal(s.blocks, 300_000);
  // And reading it again costs nothing: same object, no socket round trip. The broker
  // could be stopped entirely and this would still answer.
  await stopBroker();
  const again = cachedCtazNodeState();
  assert.equal(again.source, "rpc");
});

test("A CACHE NOBODY REFRESHES AGES OUT, it does not describe a dead node forever", async () => {
  await serveBroker();
  await refreshCtazStateForTests();
  const fresh = cachedCtazNodeState(Date.now());
  assert.equal(fresh.source, "rpc", "fresh: served");
  // One tick past the contract's own cutoff, the answer is withdrawn. The cutoff is
  // imported rather than copied: the first version hardcoded 91_000, the constant was
  // resized to the node's measured latency, and the test failed for tracking a number
  // instead of the contract. This is the property that makes caching safe here at all,
  // and cache.ts must not be the one layer allowed to lie about age.
  const stale = cachedCtazNodeState(Date.now() + MAX_CACHE_AGE_MS + 1_000);
  assert.equal(stale.source, "none", "aged out: withdrawn");
  assert.equal(stale.reading.state, "cannot-verify");
  await stopBroker();
});

test("a refresh against a dead broker leaves an aged-out cache, not a crash", async () => {
  // Explicitly dead, not incidentally: an assertion failure in an earlier test skips
  // that test's own stopBroker() and this one then measured a live broker by accident.
  await stopBroker();
  await refreshCtazStateForTests();
  const s = cachedCtazNodeState();
  // No socket at all: the raw reader falls to file (absent) then none.
  assert.equal(s.source, "none");
});

test("A COLD CACHE WAITS FOR THE WARM-UP instead of racing it", async () => {
  // The CI flake this closes: server boots, page loads immediately, first status
  // request beats the boot refresh and renders not-ready against a healthy double.
  // Against a fast broker the warm variant must return the real answer on the very
  // first call.
  await serveBroker();
  const { cachedCtazNodeStateWarm } = await import("./cache.ts");
  const s = await cachedCtazNodeStateWarm();
  assert.equal(s.source, "rpc", "first call after boot must not lose to its own warm-up");
  await stopBroker();
});

test("and the cold wait is BOUNDED, so a slow node cannot hang the first request", async () => {
  // No broker at all: the connect fails fast, the refresh settles, and the bounded
  // wait returns promptly either way. The assertion is on the clock, because the
  // property is latency, not the verdict.
  const { cachedCtazNodeStateWarm } = await import("./cache.ts");
  const t0 = Date.now();
  const s = await cachedCtazNodeStateWarm(Date.now(), 500);
  const ms = Date.now() - t0;
  assert.ok(ms < 2_000, `first cold call took ${ms}ms against a 500ms cap`);
  assert.equal(s.reading.state, "cannot-verify", "and the honest cold answer stands");
});
