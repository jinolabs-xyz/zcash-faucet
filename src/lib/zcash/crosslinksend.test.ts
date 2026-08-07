/**
 * The cTAZ sender, against the double rather than against a mock I wrote in this file.
 *
 * The double refuses bare-string params the way the real node does, so if this sender
 * ever sends the wrong shape these tests go red instead of certifying it. That is the
 * whole reason the double exists and it is the property most worth keeping.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

process.env.FAUCET_CTAZ_EXPECTED_ZAT = "50000000";
const PORT = 28611;
const URL = `http://127.0.0.1:${PORT}/`;

const { CrosslinkSender, CrosslinkAmountDrift } = await import("./crosslinksend.ts");

let node: ChildProcess;
const req = (addr: string) => ({
  toAddress: addr,
  addressInfo: { kind: "unified", shielded: true } as never,
  amountZat: 10_000_000n,
});

/** These drive the HTTP path deliberately: it is the development transport, and the
 *  fake node speaks HTTP. The SOCKET path - which is the only one production has - gets
 *  its own file, crosslinksocket.test.ts, running the real broker script. */
const http = (rpcUrl: string) => ({ socketPath: "", rpcUrl, timeoutMs: 15_000 });

const start = async (env: Record<string, string> = {}, port = PORT) => {
  const p = spawn("node", ["scripts/fake-crosslink.mjs"], {
    env: { ...process.env, PORT: String(port), ...env }, stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "is_tfl_activated", params: [] }),
      });
      return p;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`double never came up on ${port}`);
};

before(async () => { node = await start(); });
after(() => { node?.kill(); });

test("a donation succeeds and reports the amount the network actually paid", async () => {
  const r = await new CrosslinkSender(http(URL)).send(req("utest1aaaaaaaaaa"));
  assert.equal(r.amountZat, 50_000_000n);
});

test("NO TXID IS RETURNED, because their reply has none to give", async () => {
  // The property the whole SendResult widening exists for. If this ever starts carrying
  // a txid, either their surface changed or we invented one, and both need looking at.
  const r = await new CrosslinkSender(http(URL)).send(req("utest1bbbbbbbbbb"));
  assert.equal(r.txid, undefined, "a txid here would have to have been manufactured");
  assert.equal(r.explorerUrl, undefined, "there is no transaction to link to");
});

test("BALANCE THROWS rather than returning zero, so the panel says unknown", async () => {
  // Their surface has no balance RPC at all. Returning 0n would be volunteering the
  // `balance ?? 0` bug rather than inheriting it: an unreadable balance is not an empty
  // wallet, and this faucet has been bitten by exactly that confusion before.
  await assert.rejects(() => new CrosslinkSender(http(URL)).balance(), /no balance RPC|unknown rather than zero/);
});

test("a busy queue is a try-later, not a breakage", async () => {
  const busy = await start({ FAUCET_BUSY: "1" }, PORT + 1);
  try {
    await assert.rejects(
      () => new CrosslinkSender(http(`http://127.0.0.1:${PORT + 1}/`)).send(req("utest1cccccccccc")),
      /busy/i,
      "their 16-deep queue and pending-dedupe both surface as busy, and both mean try later",
    );
  } finally { busy.kill(); }
});

test("a rejected address surfaces as an error rather than a silent no-op", async () => {
  // The double refuses an address it cannot use, the same way the real node refused a
  // junk one in the spike.
  await assert.rejects(() => new CrosslinkSender(http(URL)).send(req("short")), /Invalid params/);
});

test("AN AMOUNT THAT IS NOT WHAT WE EXPECTED IS DRIFT, and it says the claim was paid", async () => {
  // Their FAUCET_VALUE is a constant in their wallet code. If they change it, this is
  // where we find out, rather than the page going on promising a number the network no
  // longer pays. The error names the paid amount, because the money DID move and a caller
  // must not read this as nothing having happened.
  const expectingLess = new CrosslinkSender(http(URL), 40_000_000n);
  await assert.rejects(
    () => expectingLess.send(req("utest1dddddddddd")),
    (e: unknown) => {
      assert.ok(e instanceof CrosslinkAmountDrift, `expected drift, got ${e}`);
      assert.equal(e.actual, 50_000_000n, "the paid amount is the authoritative one");
      assert.equal(e.expected, 40_000_000n);
      assert.match(String(e), /was PAID/, "the error must say the money moved");
      return true;
    },
  );
});

test("an unreadable reply is an unknown outcome, not a success", async () => {
  const bad = await start({ FAUCET_ERROR: "node is resyncing" }, PORT + 2);
  try {
    await assert.rejects(
      () => new CrosslinkSender(http(`http://127.0.0.1:${PORT + 2}/`)).send(req("utest1eeeeeeeeee")),
      /resyncing/,
    );
  } finally { bad.kill(); }
});

test("the sender is named, so the route can derive the no-txid exemption from it", () => {
  // route.ts keys the ledger exemption off this name rather than being told, so nothing
  // can claim "this network has no txid" for a network that does.
  assert.equal(new CrosslinkSender(http(URL)).name, "crosslink");
  assert.ok(CrosslinkAmountDrift);
});
