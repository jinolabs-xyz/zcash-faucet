import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "./address.ts";

// Zallet profile, pinned before the dynamic imports (config reads env once).
// The RPC URL points at a closed port so nothing real is ever reachable, and
// the poll interval sits at its 250ms floor to keep the opid tests quick.
process.env.FAUCET_SENDER = "zallet";
process.env.ZALLET_ACCOUNT = "11111111-2222-3333-4444-555555555555";
process.env.ZALLET_ADDRESS = "utest1faucetunifiedaddressfixture";
process.env.ZALLET_RPC_URL = "http://127.0.0.1:59999/";
process.env.ZALLET_POLL_MS = "250";

const { ZalletSender } = await import("./zalletsend.ts");
const { ZalletRefiller } = await import("../reserve/zalletRefiller.ts");
const { safeBalance } = await import("./send.ts");

const UA_INFO: AddressInfo = { valid: true, kind: "unified", shielded: true };
const TM_INFO: AddressInfo = { valid: true, kind: "transparent", shielded: false };

/**
 * Install a fake JSON-RPC endpoint by replacing global fetch. Handlers get the
 * parsed params array and return the JSON-RPC result. Calls are recorded so
 * tests can assert on exact wire params.
 */
const realFetch = globalThis.fetch;
type Handler = (params: unknown[]) => unknown;
function mockRpc(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push({ method: req.method, params: req.params });
    const handler = handlers[req.method];
    if (!handler) return new Response(JSON.stringify({ error: { code: -32601, message: `no handler for ${req.method}` } }), { status: 200 });
    return new Response(JSON.stringify({ result: handler(req.params) }), { status: 200 });
  }) as typeof fetch;
  return calls;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("balance sums every pool from z_getbalanceforaccount", async () => {
  const calls = mockRpc({
    z_getbalanceforaccount: () => ({ pools: { orchard: { valueZat: "500" }, sapling: { valueZat: 250 }, transparent: {} } }),
  });
  assert.equal(await new ZalletSender().balance(), 750n);
  assert.deepEqual(calls[0].params, ["11111111-2222-3333-4444-555555555555", 10]);
});

test("send: z_sendmany with exact amount literal, then opid poll to txid", async () => {
  let statusPolls = 0;
  const calls = mockRpc({
    z_sendmany: () => "opid-abc",
    z_getoperationstatus: () => [{ id: "opid-abc", status: ++statusPolls < 2 ? "executing" : "success" }],
    z_getoperationresult: () => [{ id: "opid-abc", status: "success", result: { txid: "f".repeat(64) } }],
  });
  const result = await new ZalletSender().send({ toAddress: "utest1recipient", addressInfo: UA_INFO, amountZat: 12_345_678n });
  assert.equal(result.txid, "f".repeat(64));

  const sendCall = calls.find((c) => c.method === "z_sendmany");
  const [from, outputs, minconf, fee, policy] = sendCall!.params as [string, Array<{ address: string; amount: number }>, number, null, string];
  assert.equal(from, "utest1faucetunifiedaddressfixture");
  assert.equal(outputs[0].address, "utest1recipient");
  assert.equal(outputs[0].amount, 0.12345678); // exact decimal, no float drift
  assert.equal(minconf, 10);
  assert.equal(fee, null); // ZIP 317 always
  assert.equal(policy, "FullPrivacy"); // shielded recipient keeps the strict default
  assert.ok(statusPolls >= 2, "polled while executing instead of reaping early");
});

test("send to a transparent recipient opts into AllowRevealedRecipients", async () => {
  const calls = mockRpc({
    z_sendmany: () => "opid-t",
    z_getoperationstatus: () => [{ id: "opid-t", status: "success" }],
    z_getoperationresult: () => [{ id: "opid-t", status: "success", result: { txid: "a".repeat(64) } }],
  });
  await new ZalletSender().send({ toAddress: "tmRecipient", addressInfo: TM_INFO, amountZat: 10_000_000n });
  const [, , , , policy] = calls.find((c) => c.method === "z_sendmany")!.params as [string, unknown, number, null, string];
  assert.equal(policy, "AllowRevealedRecipients");
});

test("send surfaces the wallet's failure message", async () => {
  mockRpc({
    z_sendmany: () => "opid-bad",
    z_getoperationstatus: () => [{ id: "opid-bad", status: "failed" }],
    z_getoperationresult: () => [{ id: "opid-bad", status: "failed", error: { code: -6, message: "Insufficient funds" } }],
  });
  await assert.rejects(
    () => new ZalletSender().send({ toAddress: "utest1recipient", addressInfo: UA_INFO, amountZat: 1n }),
    /Insufficient funds/,
  );
});

test("refiller step sweeps by account UUID with the 50-UTXO cap", async () => {
  let statusPolls = 0;
  const calls = mockRpc({
    z_shieldcoinbase: () => ({ opid: "opid-shield", shieldingUTXOs: 3 }),
    z_getoperationstatus: () => [{ id: "opid-shield", status: ++statusPolls < 2 ? "queued" : "success" }],
    z_getoperationresult: () => [{ id: "opid-shield", status: "success" }],
  });
  await new ZalletRefiller().step();
  const shield = calls.find((c) => c.method === "z_shieldcoinbase");
  assert.deepEqual(shield!.params, ["11111111-2222-3333-4444-555555555555", "utest1faucetunifiedaddressfixture", null, 50]);
  assert.ok(calls.some((c) => c.method === "z_getoperationresult"), "collected the final result");
});

test("refiller step with nothing to shield is a clean no-op", async () => {
  const calls = mockRpc({
    z_shieldcoinbase: () => ({ remainingUTXOs: 0 }), // no opid: nothing eligible
  });
  await new ZalletRefiller().step();
  assert.equal(calls.length, 1, "no polling without an opid");
});

test("safeBalance is null, never a throw, when the wallet is unreachable", async () => {
  // Real fetch against the closed port from the env above.
  assert.equal(await safeBalance(), null);
});

