/**
 * THE READER MUST TRY THE PATH THE GATE DEMANDS.
 *
 * Three individually-correct changes composed into a faucet that could never serve:
 * #411 gave the container a working RPC route (the socket), #410 made the gate refuse
 * any state that did not arrive over RPC, and the reader answered from the status file
 * before ever trying the socket. Socket working, gate demanding rpc, reader saying file.
 * servable:false on a healthy node, forever, on prod.
 *
 * These tests run the real reader against a real unix socket served by a fake broker
 * and a real status file on disk, and assert the ORDER: RPC wins when it answers, the
 * file is the fallback and only the fallback, and the gate can actually be satisfied
 * end to end. The last one is the whole point - each layer had its own green tests
 * while the composition was dead.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ctaz-order-"));
const SOCK = join(dir, "rpc.sock");
const FILE = join(dir, "ctaz-status.json");

// Config resolves env at module load, so all of it is set before the import below.
process.env.FAUCET_CTAZ_ENABLED = "true";
process.env.FAUCET_CTAZ_RPC_SOCKET = SOCK;
process.env.CROSSLINK_RPC_URL = "";
process.env.FAUCET_CTAZ_STATUS_FILE = FILE;

const { readCtazNodeState } = await import("./read.ts");
const { canServeCtaz } = await import("./recency.ts");

const NOW = 1_700_000_000_000;

/** A broker double on a real socket: one JSON request in, one reply out. */
let server: Server | null = null;
function serveBroker(blocks: number, tip: number): Promise<void> {
  return new Promise((resolve) => {
    server = createServer({ allowHalfOpen: true }, (conn) => {
      let raw = "";
      conn.on("data", (d) => (raw += d));
      conn.on("end", () => {
        const req = JSON.parse(raw) as { id: number; method: string };
        // THE REAL RecencyStatus SHAPE, copied from readingFor's own field list rather
        // than invented. My first version made up field names, the reading came back
        // cannot-verify, and the end-to-end test failed for a reason that had nothing
        // to do with the order being tested. A fixture in the wrong shape is a second
        // bug standing in front of the one you are hunting.
        const result =
          req.method === "get_tfl_recency_status"
            ? {
                now_utc: Math.floor(NOW / 1000) - 5,
                my_height: 294_800,
                my_round: 12,
                my_locked_round: 11,
                finalizer_statuses: Array.from({ length: 46 }, () => ({})),
              }
            : { blocks, estimatedheight: tip, headers: tip };
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

/** A fresh, healthy status file, which is prod's exact state during the deadlock. */
function writeFreshFile() {
  writeFileSync(
    FILE,
    JSON.stringify({
      readable: true,
      at: NOW - 30_000,
      blocks: 100,
      tip: 200,
      syncPercent: 50,
      // The REAL shape here too. With an invented shape the reading is cannot-verify,
      // and the fallback test's "gate still refuses" would pass for that reason - it
      // would keep passing even if the source check were deleted. With a READY file
      // reading, the refusal below is provably about source alone.
      recency: {
        now_utc: Math.floor(NOW / 1000) - 5,
        my_height: 100,
        my_round: 9,
        my_locked_round: 8,
        finalizer_statuses: Array.from({ length: 46 }, () => ({})),
      },
    }),
  );
}

before(async () => {
  await serveBroker(294_800, 294_801);
  writeFreshFile();
});
after(async () => {
  await stopBroker();
  rmSync(dir, { recursive: true, force: true });
});

test("THE DEADLOCK: with a fresh file AND a working socket, the RPC must win", async () => {
  // This is prod at the moment the bug was found: broker answering real chain data,
  // status file fresh, page saying servable:false. The old reader returned the file
  // here and the gate refused it, permanently.
  const s = await readCtazNodeState(NOW);
  assert.equal(s.source, "rpc", "the reader answered from the file while the socket worked");
  assert.equal(s.blocks, 294_800, "and the figures are the node's, not the file's");
});

test("and that state actually SERVES, which is the composition nobody tested", async () => {
  const s = await readCtazNodeState(NOW);
  assert.equal(
    canServeCtaz(s.reading.state, s.blocks ?? s.reading.height, s.tip, s.source),
    true,
    "a healthy node reachable over the socket must be servable end to end",
  );
});

test("a dead broker falls back to the file, for the panel, and the gate still refuses", async () => {
  await stopBroker();
  try {
    const s = await readCtazNodeState(NOW);
    assert.equal(s.source, "file", "the file is the fallback, so the panel stays informative");
    assert.equal(s.blocks, 100, "with the file's figures");
    assert.equal(s.reading.state, "ready", "the file reading itself is READY, so the refusal below is source alone");
    assert.equal(
      canServeCtaz(s.reading.state, s.blocks, s.tip, s.source),
      false,
      "but nothing from the file path may serve: paying needs the path that just failed",
    );
  } finally {
    await serveBroker(294_800, 294_801);
  }
});

test("a dead broker AND no file is source none, not a pretend answer", async () => {
  await stopBroker();
  rmSync(FILE, { force: true });
  try {
    const s = await readCtazNodeState(NOW);
    assert.equal(s.source, "none");
    assert.equal(s.reading.state, "cannot-verify");
  } finally {
    writeFreshFile();
    await serveBroker(294_800, 294_801);
  }
});

test("A SLOW NODE'S REPLY IS CLASSIFIED AT REPLY TIME, not against the pre-call clock", async () => {
  // The production failure: this node takes 16-45s to answer recency and stamps now_utc
  // when it finally does. Classifying against a timestamp captured before the call made
  // the age negative, and the future-now_utc guard rejected every honest slow reply -
  // cannot-verify forever, from a healthy node, within every timeout.
  //
  // The broker double here delays 1.5s and stamps now_utc at reply time, exactly like
  // the real node. Under pre-call classification this reads cannot-verify; classified
  // at reply time it is ready.
  await stopBroker();
  const slow: Server = createServer({ allowHalfOpen: true }, (conn) => {
    let raw = "";
    conn.on("data", (d) => (raw += d));
    conn.on("end", () => {
      const req = JSON.parse(raw) as { id: number; method: string };
      setTimeout(() => {
        const result =
          req.method === "get_tfl_recency_status"
            ? {
                // Stamped NOW, after the delay, like the real node.
                now_utc: Math.floor((NOW + 1_500) / 1000),
                my_height: 294_800,
                my_round: 0,
                // -1 is BFT's "no round locked yet", seen on the live net. It must not
                // be treated as an invalid field.
                my_locked_round: -1,
                finalizer_statuses: Array.from({ length: 47 }, () => ({})),
              }
            : { blocks: 294_800, estimatedheight: 294_801, headers: 294_801 };
        conn.end(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
      }, 1_500);
    });
  });
  await new Promise<void>((r) => slow.listen(SOCK, r));
  try {
    const s = await readCtazNodeState(NOW);
    assert.equal(s.reading.state, "ready", `a slow honest reply must classify ready, got ${s.reading.state}`);
    assert.equal(
      canServeCtaz(s.reading.state, s.blocks ?? s.reading.height, s.tip, s.source),
      true,
      "and it serves end to end",
    );
  } finally {
    await new Promise<void>((r) => slow.close(() => r()));
    rmSync(SOCK, { force: true });
    await serveBroker(294_800, 294_801);
    writeFreshFile();
  }
});
