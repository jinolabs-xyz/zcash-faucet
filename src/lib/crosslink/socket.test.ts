/**
 * THE WHOLE CHAIN, WITH THE REAL BROKER (#409).
 *
 * sender → unix socket → ctaz-rpc-broker.sh → node. Every link is the shipped one except
 * the node itself, which is a fake speaking the same JSON-RPC.
 *
 * This file exists because the alternative is what shipped last time. `crosslinksend.test.ts`
 * drove the sender over HTTP against a fake node and passed for days, while in production
 * the sender called `fetch("")` and could not have reached the node even with a URL. Both
 * halves were individually correct; nothing ran the path production actually uses.
 *
 * So the broker here is `deploy/z3/ctaz-rpc-broker.sh` itself, invoked the way systemd
 * invokes it - connection on stdin and stdout, one request per instance. A change to that
 * script that breaks the contract reds this, which is the only reason to trust it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as httpServer, type Server } from "node:http";
import { rpcOverSocket } from "./transport.ts";
import { CrosslinkSender } from "../zcash/crosslinksend.ts";

const BROKER = fileURLToPath(new URL("../../../deploy/z3/ctaz-rpc-broker.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ctaz-sock-"));
const SOCK = join(dir, "ctaz-rpc.sock");

/** What the fake node was asked, so the allowlist can be shown to actually block. */
let sawMethods: string[] = [];
let node: Server;
let nodeUrl = "";
let listener: ReturnType<typeof createServer>;

/**
 * Stands in for systemd's Accept=yes: one broker process per connection, with the socket
 * wired to its stdin and stdout. If this drifts from the unit, the unit is wrong - both
 * are written from the same three lines of ctaz-rpc@.service.
 */
function serveWithRealBroker(): Promise<void> {
  return new Promise((resolve) => {
    // allowHalfOpen IS LOAD BEARING. Node's default closes the server's WRITE side the
    // instant the client half-closes its own, so the reply was being cut off before the
    // broker had produced it - the failure read as "the broker closed without answering",
    // which points at the broker rather than at the harness holding it. systemd's socket
    // does not do this, so without the flag the test would be modelling a socket the unit
    // never creates.
    listener = createServer({ allowHalfOpen: true }, (conn) => {
      const p = spawn("bash", [BROKER], {
        env: { ...process.env, CTAZ_RPC_URL: nodeUrl, CTAZ_BROKER_TIMEOUT: "10" },
        stdio: ["pipe", "pipe", process.env.BROKER_DEBUG ? "inherit" : "ignore"],
      });
      conn.pipe(p.stdin);
      p.stdout.pipe(conn);
      p.on("close", () => conn.end());
    });
    listener.listen(SOCK, resolve);
  });
}

before(async () => {
  await new Promise<void>((resolve) => {
    node = httpServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const j = JSON.parse(body || "{}");
        sawMethods.push(j.method);
        res.setHeader("content-type", "application/json");
        if (j.method === "requestfaucetdonation") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { amount: 50_000_000 } }));
        } else if (j.method === "getblockchaininfo") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { blocks: 294_800, estimatedheight: 294_801 } }));
        } else {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { ok: true } }));
        }
      });
    }).listen(0, "127.0.0.1", () => {
      const a = node.address();
      nodeUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/`;
      resolve();
    });
  });
  await serveWithRealBroker();
});

after(() => {
  listener?.close();
  node?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a drip reaches the node THROUGH the socket and the real broker", async () => {
  sawMethods = [];
  const sender = new CrosslinkSender({ socketPath: SOCK, rpcUrl: "", timeoutMs: 10_000 });
  const r = await sender.send({
    toAddress: "utest1aaaaaaaaaa",
    addressInfo: { kind: "unified", shielded: true } as never,
    amountZat: 50_000_000n,
  });
  assert.equal(r.amountZat, 50_000_000n);
  assert.deepEqual(sawMethods, ["requestfaucetdonation"], "the node saw exactly the one call");
});

test("the reader's sync call goes through too, which is what makes the gate say rpc", async () => {
  const { reply, via } = await rpcOverSocket(SOCK, "getblockchaininfo", [], 10_000);
  assert.equal(via, "socket");
  assert.equal((reply?.result as { blocks?: number })?.blocks, 294_800);
});

test("A METHOD OUTSIDE THE ALLOWLIST NEVER REACHES THE NODE", async () => {
  // The security property, and the reason this is a broker rather than a plain proxy.
  // The thing on the other end of this socket is an internet-facing web app; forwarding
  // whatever it sends would make an app compromise into full control of a funded node,
  // which is worse than the bridge binding this design exists to avoid.
  sawMethods = [];
  const { reply } = await rpcOverSocket(SOCK, "stop", [], 10_000);
  assert.equal(reply?.error?.code, -32601);
  assert.match(reply?.error?.message ?? "", /not permitted/i);
  assert.deepEqual(sawMethods, [], "the node must not have been asked at all");
});

test("and the refusal is JSON-RPC shaped, so the caller has one parse path", async () => {
  const { reply } = await rpcOverSocket(SOCK, "generate", [100], 10_000);
  assert.ok(reply, "a refusal is still an answer");
  assert.equal(reply?.error?.code, -32601);
});

test("garbage in is refused rather than forwarded", async () => {
  sawMethods = [];
  const raw = await new Promise<string>((resolve) => {
    const c = connect(SOCK);
    let out = "";
    c.on("connect", () => c.end("this is not json at all"));
    c.on("data", (d) => (out += d));
    c.on("end", () => resolve(out));
  });
  assert.match(raw, /-32700|not JSON/);
  assert.deepEqual(sawMethods, []);
});

test("A NODE THAT DOES NOT ANSWER IS NOT A SUCCESSFUL SEND", async () => {
  // The failure that matters on a money path. The sender must throw, not return a
  // SendResult, or a claim gets recorded against a payment that never happened.
  const sender = new CrosslinkSender({ socketPath: join(dir, "nope.sock"), rpcUrl: "", timeoutMs: 2_000 });
  await assert.rejects(
    sender.send({
      toAddress: "utest1aaaaaaaaaa",
      addressInfo: { kind: "unified", shielded: true } as never,
      amountZat: 50_000_000n,
    }),
    /crosslink rpc requestfaucetdonation/,
  );
});

test("A BROKEN SOCKET DOES NOT SILENTLY FALL BACK TO HTTP", async () => {
  // Added because a sabotage caught nothing. transport.ts says "a configured socket that
  // does not answer is the answer", and I had written that as a comment with no assertion
  // under it: patching ctazRpc to retry over HTTP when the socket failed passed all seven
  // tests here. A property claimed in prose and checked nowhere is rule 35 exactly, in
  // code written the same hour as the rule was cited.
  //
  // It matters because production configures BOTH: the socket, and an rpcUrl left over
  // from development. A fallback would mean a dead broker silently becomes a direct call
  // that cannot work from the container - failing at the transport, with the socket's real
  // failure hidden behind it.
  const { ctazRpc } = await import("./transport.ts");
  const { reply, via, failure } = await ctazRpc(
    { socketPath: join(dir, "not-a-socket.sock"), rpcUrl: nodeUrl, timeoutMs: 2_000 },
    "getblockchaininfo",
  );
  assert.equal(reply, null, "a broken socket must not be rescued by the http path");
  assert.equal(via, null);
  assert.ok(failure, "and it has to say what went wrong");
});

test("no transport configured at all fails closed, it does not fall back to nothing", async () => {
  const sender = new CrosslinkSender({ socketPath: "", rpcUrl: "", timeoutMs: 1_000 });
  await assert.rejects(
    sender.send({
      toAddress: "utest1aaaaaaaaaa",
      addressInfo: { kind: "unified", shielded: true } as never,
      amountZat: 50_000_000n,
    }),
    /no crosslink transport configured/,
  );
});

