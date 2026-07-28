import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "./address.ts";

// Zallet profile with tiny timings so the retry and deadline paths are fast.
process.env.FAUCET_SENDER = "zallet";
process.env.ZALLET_ACCOUNT = "acct-inflight";
process.env.ZALLET_ADDRESS = "utest1inflightfixture";
process.env.ZALLET_RPC_URL = "http://127.0.0.1:59998/";
process.env.ZALLET_POLL_MS = "250";
process.env.ZALLET_OP_TIMEOUT_MS = "5000";

const { ZalletSender } = await import("./zalletsend.ts");
const { SendOutcomeUnknownError } = await import("./send.ts");

const UA: AddressInfo = { valid: true, kind: "unified", shielded: true };
const req = { toAddress: "utest1recipient", addressInfo: UA, amountZat: 10_000_000n };

const realFetch = globalThis.fetch;
type Handler = (params: unknown[], call: number) => unknown;
/** Fake JSON-RPC. A handler may throw to simulate a transport failure. */
function mockRpc(handlers: Record<string, Handler>) {
  const counts: Record<string, number> = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    counts[method] = (counts[method] ?? 0) + 1;
    const handler = handlers[method];
    if (!handler) return new Response(JSON.stringify({ error: { code: -32601, message: method } }), { status: 200 });
    const result = handler(params, counts[method]);
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;
  return counts;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a transient status blip does not kill a send that is progressing", async () => {
  const counts = mockRpc({
    z_sendmany: () => "opid-blip",
    z_getoperationstatus: (_p, call) => {
      // First two polls fail at the transport, the third answers.
      if (call <= 2) throw new Error("ECONNRESET");
      return [{ id: "opid-blip", status: "success" }];
    },
    z_getoperationresult: () => [{ id: "opid-blip", status: "success", result: { txid: "c".repeat(64) } }],
  });

  const result = await new ZalletSender().send(req);
  assert.equal(result.txid, "c".repeat(64), "a healthy send was aborted by a blip");
  assert.equal(counts.z_getoperationstatus, 3, "should have retried the failed polls");
});

test("polls exhausted means UNKNOWN, never a clean failure", async () => {
  mockRpc({
    z_sendmany: () => "opid-dead",
    z_getoperationstatus: () => {
      throw new Error("ECONNREFUSED");
    },
  });

  const err = await new ZalletSender().send(req).then(() => null, (e) => e);
  assert.ok(err instanceof SendOutcomeUnknownError, `expected unknown-outcome, got ${err?.name}: ${err?.message}`);
  assert.equal(err.opid, "opid-dead", "the opid must survive on the error for reconciliation");
});

test("the deadline expiring while still executing is UNKNOWN, the wallet may still broadcast", async () => {
  mockRpc({
    z_sendmany: () => "opid-slow",
    z_getoperationstatus: () => [{ id: "opid-slow", status: "executing" }],
  });

  const err = await new ZalletSender().send(req).then(() => null, (e) => e);
  assert.ok(err instanceof SendOutcomeUnknownError, `expected unknown-outcome, got ${err?.name}`);
  assert.equal(err.opid, "opid-slow");
  assert.match(err.message, /still executing/);
});

test("an unreadable result after the op finished is UNKNOWN, coins may be gone", async () => {
  mockRpc({
    z_sendmany: () => "opid-unreadable",
    z_getoperationstatus: () => [{ id: "opid-unreadable", status: "success" }],
    z_getoperationresult: () => {
      throw new Error("socket hang up");
    },
  });

  const err = await new ZalletSender().send(req).then(() => null, (e) => e);
  assert.ok(err instanceof SendOutcomeUnknownError, `expected unknown-outcome, got ${err?.name}`);
  assert.match(err.message, /result unreadable/);
});

test("the wallet saying 'failed' IS definite, not unknown", async () => {
  // This is the one case where we know nothing moved, so the caller is free to
  // release the cooldown and tell the user to retry.
  mockRpc({
    z_sendmany: () => "opid-refused",
    z_getoperationstatus: () => [{ id: "opid-refused", status: "failed" }],
    z_getoperationresult: () => [
      { id: "opid-refused", status: "failed", error: { code: -6, message: "Insufficient funds" } },
    ],
  });

  const err = await new ZalletSender().send(req).then(() => null, (e) => e);
  assert.ok(!(err instanceof SendOutcomeUnknownError), "a definite wallet refusal must not be reported as unknown");
  assert.match(err.message, /Insufficient funds/);
});

test("a success with no txid is UNKNOWN rather than a silent empty result", async () => {
  mockRpc({
    z_sendmany: () => "opid-notxid",
    z_getoperationstatus: () => [{ id: "opid-notxid", status: "success" }],
    z_getoperationresult: () => [{ id: "opid-notxid", status: "success", result: {} }],
  });

  const err = await new ZalletSender().send(req).then(() => null, (e) => e);
  assert.ok(err instanceof SendOutcomeUnknownError, `expected unknown-outcome, got ${err?.name}`);
});

test("a failure BEFORE the opid exists is a clean failure, nothing was submitted", async () => {
  mockRpc({
    z_sendmany: () => {
      throw new Error("wallet locked");
    },
  });

  const err = await new ZalletSender().send(req).then(() => null, (e) => e);
  assert.ok(!(err instanceof SendOutcomeUnknownError), "nothing was submitted, so this is not ambiguous");
});
