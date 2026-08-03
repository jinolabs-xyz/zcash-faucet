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
const { safeBalance, safeDonations, resetDonationCache } = await import("./send.ts");

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

// The refiller's two step() tests moved to ../reserve/shieldGateWiring.test.ts.
// They need a primed tip oracle now that the sweep refuses to broadcast behind a
// stale node, and without one they pass for the wrong reason: "nothing to shield"
// stays green on a step that never asked the wallet anything.

test("safeBalance is null, never a throw, when the wallet is unreachable", async () => {
  // Real fetch against the closed port from the env above.
  assert.equal(await safeBalance(), null);
});


/* ------------------------------------------------------------------ donations (#192) */

/** One confirmed donation, in zallet's WalletTx shape. */
function donationTx(i: number) {
  return {
    txid: `d${i}`,
    mined_height: 4_000_000 + i,
    sent_note_count: 0,
    outputs: [{ pool: "ironwood", from_account: null, value: 100_000_000, is_change: false }],
  };
}

test("donations pages z_listtransactions and stops on a short page", async () => {
  const pages = [Array.from({ length: 500 }, (_, i) => donationTx(i)), [donationTx(500)]];
  const calls = mockRpc({ z_listtransactions: (p) => pages[Number(p[3]) / 500] ?? [] });

  const { tally, complete } = await new ZalletSender().donations();
  assert.equal(complete, true);
  assert.equal(tally.count, 501, "the second page was dropped or the first was re-read");
  assert.equal(calls.length, 2, "stopped one call late or early");
  // The wire params are positional, so the order is the contract with zallet.
  assert.deepEqual(calls[0].params, ["11111111-2222-3333-4444-555555555555", null, null, 0, 500]);
  assert.deepEqual(calls[1].params, ["11111111-2222-3333-4444-555555555555", null, null, 500, 500]);
});

test("a history longer than the page cap is reported INCOMPLETE, not partial", async () => {
  // The rule that matters: a cumulative total from a truncated scan is not a
  // smaller number, it is a wrong one, so it must not reach the page.
  const full = Array.from({ length: 500 }, (_, i) => donationTx(i));
  const calls = mockRpc({ z_listtransactions: () => full });

  const { tally, complete } = await new ZalletSender().donations();
  assert.equal(complete, false);
  assert.ok(tally.count > 0, "it still tallied what it saw");
  assert.equal(calls.length, 20, "the page cap did not hold, so a bad wallet could loop forever");

  resetDonationCache();
  mockRpc({ z_listtransactions: () => full });
  assert.equal(await safeDonations(), null, "an incomplete tally was published anyway");
});

test("safeDonations never blocks a render: null first, value once the scan lands, one scan total", async () => {
  // The contract changed deliberately: the scan measured ~9s cold on production
  // and the old shape charged it inline to the first visitor after every cache
  // expiry, on the money page. Now the first cold call returns null immediately
  // and STARTS the scan; later calls serve the landed value; and the caching
  // property this test always guarded still holds, exactly one wallet hit.
  resetDonationCache();
  const calls = mockRpc({ z_listtransactions: (p) => (Number(p[3]) === 0 ? [donationTx(1)] : []) });

  const t0 = Date.now();
  const first = await safeDonations();
  assert.ok(Date.now() - t0 < 500, "the cold call must not await the scan");
  assert.equal(first, null, "cold render omits the counter rather than waiting");

  // Let the background refresh land, then the value is served without a re-scan.
  await new Promise((r) => setTimeout(r, 25));
  const second = await safeDonations();
  assert.equal(second?.count, 1, "the background result is served once landed");
  const third = await safeDonations();
  assert.equal(third?.count, 1);
  assert.equal(calls.length, 1, "a later render hit the wallet again");
});

test("safeDonations single-flight: concurrent cold renders share one scan", async () => {
  resetDonationCache();
  const calls = mockRpc({ z_listtransactions: (p) => (Number(p[3]) === 0 ? [donationTx(1)] : []) });
  await Promise.all([safeDonations(), safeDonations(), safeDonations()]);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(calls.length, 1, "three simultaneous expiries stampeded the wallet");
});

test("safeDonations is null, never a throw, when the wallet is unreachable", async () => {
  // /donate is the page that still works when the faucet is dry. A counter that
  // cannot load must hide itself rather than 500 the page.
  resetDonationCache();
  assert.equal(await safeDonations(), null); // real fetch, closed port
});
