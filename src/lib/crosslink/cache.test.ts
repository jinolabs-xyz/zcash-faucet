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

const { cachedCtazNodeState, refreshCtazStateForTests, resetCtazStateCacheForTests } =
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
  // 91 seconds later with no refresh, the answer is withdrawn. This is the property that
  // makes caching safe here at all: the status file has the same rule, for the same
  // reason, and cache.ts must not be the one layer allowed to lie about age.
  const stale = cachedCtazNodeState(Date.now() + 91_000);
  assert.equal(stale.source, "none", "aged out: withdrawn");
  assert.equal(stale.reading.state, "cannot-verify");
  await stopBroker();
});

test("a refresh against a dead broker leaves an aged-out cache, not a crash", async () => {
  await refreshCtazStateForTests();
  const s = cachedCtazNodeState();
  // No socket at all: the raw reader falls to file (absent) then none.
  assert.equal(s.source, "none");
});
