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
const ZS_INFO: AddressInfo = { valid: true, kind: "sapling", shielded: true };

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

test("send to a SAPLING recipient opts into AllowRevealedAmounts", async () => {
  // The wallet's notes are in Ironwood, so paying Sapling crosses pools and the moved
  // value is public. Under FullPrivacy zallet refuses to build it, and that reached two
  // users on 2026-09-10 as a bare 502 after they had already solved the proof-of-work.
  //
  // Acceptable to reveal HERE specifically: the drip is a fixed 0.1 TAZ published on the
  // homepage, so the revealed amount is a number everyone already has. The recipient's
  // note stays shielded; only the cross-pool value is in the clear. We already pay
  // transparent addresses, which reveals strictly more.
  //
  // ZIP 258 restricts ORCHARD after NU6.3, not Sapling, so there is no protocol reason
  // to turn these users away.
  const calls = mockRpc({
    z_sendmany: () => "opid-z",
    z_getoperationstatus: () => [{ id: "opid-z", status: "success" }],
    z_getoperationresult: () => [{ id: "opid-z", status: "success", result: { txid: "b".repeat(64) } }],
  });
  await new ZalletSender().send({ toAddress: "ztestsapling1recipient", addressInfo: ZS_INFO, amountZat: 10_000_000n });
  const [, , , , policy] = calls.find((c) => c.method === "z_sendmany")!.params as [string, unknown, number, null, string];
  assert.equal(policy, "AllowRevealedAmounts");
});

test("each recipient kind gets the WEAKEST policy that can build, and no weaker", async () => {
  // The three branches in one place, because the risk is drift: a future edit that made
  // unified reveal amounts, or sapling reveal recipients, would still pass the three
  // tests above if each only checked its own branch. AllowRevealedRecipients is strictly
  // weaker than AllowRevealedAmounts, so handing it to a shielded recipient would give
  // away more than the send needs.
  const seen: Record<string, string> = {};
  for (const [label, info, addr] of [
    ["unified", UA_INFO, "utest1r"],
    ["sapling", ZS_INFO, "ztestsapling1r"],
    ["transparent", TM_INFO, "tmR"],
  ] as const) {
    const calls = mockRpc({
      z_sendmany: () => "opid-p",
      z_getoperationstatus: () => [{ id: "opid-p", status: "success" }],
      z_getoperationresult: () => [{ id: "opid-p", status: "success", result: { txid: "c".repeat(64) } }],
    });
    await new ZalletSender().send({ toAddress: addr, addressInfo: info, amountZat: 10_000_000n });
    const [, , , , policy] = calls.find((c) => c.method === "z_sendmany")!.params as [string, unknown, number, null, string];
    seen[label] = policy;
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, {
    unified: "FullPrivacy",
    sapling: "AllowRevealedAmounts",
    transparent: "AllowRevealedRecipients",
  });
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

/* ------------------------------------------------------ a lost reply is not a refusal (R-26) */

const { SendOutcomeUnknownError } = await import("./send.ts");
const { sendmanyFailureIsDefinite } = await import("./zalletsend.ts");
const sendOnce = () => new ZalletSender().send({ toAddress: "utest1recipient", addressInfo: UA_INFO, amountZat: 1n });

/** fetch that fails z_sendmany the way undici does, and answers nothing else. */
function failingSendmany(make: () => unknown) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { method: string };
    if (req.method === "z_sendmany") {
      const v = make();
      if (v instanceof Response) return v;
      throw v;
    }
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  }) as typeof fetch;
}
const undiciError = (code: string, message = code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });

test("z_sendmany: the abort timer is an UNKNOWN outcome with no opid, not 'nothing left the wallet'", async () => {
  // The exact throw AbortSignal.timeout() produces: a DOMException named TimeoutError.
  failingSendmany(() => new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  await assert.rejects(sendOnce, (err: unknown) => {
    assert.ok(err instanceof SendOutcomeUnknownError, `expected SendOutcomeUnknownError, got ${String(err)}`);
    assert.equal(err.opid, "no-opid");
    assert.match(err.message, /reply lost: TimeoutError/);
    return true;
  });
});

test("z_sendmany: a socket that dropped after the body went out is unknown too", async () => {
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE"]) {
    failingSendmany(() => undiciError(code));
    await assert.rejects(sendOnce, (err: unknown) => err instanceof SendOutcomeUnknownError && err.opid === "no-opid" && new RegExp(code).test(err.message));
  }
});

test("z_sendmany: a 5xx or an unreadable reply is unknown, the method may have run", async () => {
  failingSendmany(() => new Response("upstream error", { status: 502, statusText: "Bad Gateway" }));
  await assert.rejects(sendOnce, (err: unknown) => err instanceof SendOutcomeUnknownError && /HTTP 502/.test(err.message));
  failingSendmany(() => new Response("<html>not json</html>", { status: 200 }));
  await assert.rejects(sendOnce, (err: unknown) => err instanceof SendOutcomeUnknownError);
});

test("z_sendmany: refused, unresolvable, rejected at the door, or refused by the wallet stay DEFINITE", async () => {
  // Nothing reached a wallet that could act, so the claim may be released and retried.
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
    failingSendmany(() => undiciError(code));
    await assert.rejects(sendOnce, (err: unknown) => !(err instanceof SendOutcomeUnknownError) && err instanceof Error && new RegExp(code).test(String(err.cause && (err.cause as { code?: string }).code)));
  }
  failingSendmany(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
  await assert.rejects(sendOnce, (err: unknown) => !(err instanceof SendOutcomeUnknownError) && /HTTP 401/.test(String(err)));
  failingSendmany(() => new Response(JSON.stringify({ error: { code: -6, message: "Insufficient funds" } }), { status: 200 }));
  await assert.rejects(sendOnce, (err: unknown) => !(err instanceof SendOutcomeUnknownError) && /Insufficient funds/.test(String(err)));
});

test("the classifier defaults to unknown for a shape it has not met", () => {
  assert.equal(sendmanyFailureIsDefinite(new Error("something new")), false);
  assert.equal(sendmanyFailureIsDefinite("a string"), false);
  assert.equal(sendmanyFailureIsDefinite(undiciError("ECONNREFUSED")), true);
  // Only z_sendmany's own wire errors count as its refusal; the same text for another
  // method must not be read as one.
  assert.equal(sendmanyFailureIsDefinite(new Error("zallet RPC z_getoperationstatus: boom (code 1)")), false);
});

/* ------------------------------------------- a refused recipient is not a wallet failure (R-18) */

const { RecipientRefusedError } = await import("./send.ts");
const { isRecipientRefusal } = await import("./zalletsend.ts");

// zallet's own productions (zcash/wallet payments.rs and zallet_core.ftl), which is the
// only list this classifier trusts. Every recipient problem is a synchronous -8.
const RECIPIENT = [
  "Invalid parameter, unknown address format: utest1nope",
  "Invalid parameter, duplicated recipient address: utest1x",
  "Cannot send memo to transparent recipient",
  "Cannot send zero-valued output to transparent recipient",
  "This transaction would have transparent recipients, which is not enabled by default because it will publicly reveal transaction recipients and amounts.",
  "This transaction would send to a transparent receiver of a unified address, which is not enabled by default because it will publicly reveal transaction recipients and amounts.",
  "Could not send to the Sapling shielded pool without spending non-Sapling funds, which would reveal transaction amounts.",
  "Could not send to a shielded receiver of a unified address without spending funds from a different pool, which would reveal transaction amounts.",
  // try_from_zcash_address's errors, librustzcash's own Display strings.
  "Address is for Regtest but we expected Test",
  "Invalid Sapling payment address",
  "Invalid Orchard receiver in Unified Address",
  "Invalid Sapling receiver in Unified Address",
  // zallet's privacy-policy refusals as production sends them: Fluent block text with the
  // .ftl's line breaks kept, and the recommendation sentence appended after a space
  // (payments.rs). The single-line transcriptions above never occur on the wire.
  "This transaction would have transparent recipients, which is not enabled by\ndefault because it will publicly reveal transaction recipients and amounts. THIS MAY AFFECT YOUR PRIVACY. Resubmit with the 'privacyPolicy' parameter set\nto 'AllowRevealedRecipients' or weaker if you wish to allow this transaction to proceed\nanyway.",
  "Could not send to the Sapling shielded pool without spending non-Sapling\nfunds, which would reveal transaction amounts. THIS MAY AFFECT YOUR PRIVACY. Resubmit with the 'privacyPolicy' parameter set\nto 'AllowRevealedAmounts' or weaker if you wish to allow this transaction to proceed\nanyway.",
];
// Wallet-side sentences that mention pools, addresses or policies and MUST keep counting
// against the wallet (review of #531, round 2: a keyword scan sent all of these to the
// visitor as "check your address", and the money path went invisible).
const WALLET_SIDE: Array<[number, string]> = [
  [-5, "Invalid from address: should be a taddr, zaddr, UA, or the string 'ANY_TADDR'"],
  [-5, "Invalid from address, no payment source found for address."],
  [-8, "Zallet always calculates fees internally; the fee field must be null."],
  [-8, "Unknown privacy policy NoSuchPolicy"],
  [-8, "This transaction would spend transparent funds, which is not enabled by default because it will publicly reveal transaction senders and amounts."],
  [-4, "Failed to propose transaction: After Ironwood activation, a step that spends 100000000 zatoshis from the Orchard pool may not return 50000000 zatoshis to it."],
  [-4, "Failed to propose transaction: Attempted to send change to an unsupported pool type: Transparent"],
  [-4, "The built transaction pays a transparent output that is neither a requested payment nor an address derived from the account's own key. The wallet database is corrupted or has been tampered with."],
  [-6, "Insufficient funds"],
];

test("z_sendmany: zallet's recipient refusals (-8, its own sentences) are RecipientRefusedError", async () => {
  for (const message of RECIPIENT) {
    failingSendmany(() => new Response(JSON.stringify({ error: { code: -8, message } }), { status: 200 }));
    await assert.rejects(sendOnce, (err: unknown) => err instanceof RecipientRefusedError && (err as Error).message === message, message.slice(0, 40));
  }
});

test("z_sendmany: wallet-side sentences that mention pools, addresses or policies stay wallet failures", async () => {
  for (const [code, message] of WALLET_SIDE) {
    failingSendmany(() => new Response(JSON.stringify({ error: { code, message } }), { status: 200 }));
    await assert.rejects(sendOnce, (err: unknown) => !(err instanceof RecipientRefusedError) && !(err instanceof SendOutcomeUnknownError) && String(err).includes(message.slice(0, 30)), `${code}: ${message.slice(0, 40)}`);
  }
});

test("an operation that FAILED after the opid is never the recipient's: validation happened before the opid", async () => {
  mockRpc({
    z_sendmany: () => "opid-late",
    z_getoperationstatus: () => [{ id: "opid-late", status: "failed" }],
    z_getoperationresult: () => [{ id: "opid-late", status: "failed", error: { code: -8, message: "Invalid parameter, unknown address format: utest1x" } }],
  });
  await assert.rejects(sendOnce, (err: unknown) => !(err instanceof RecipientRefusedError) && /unknown address format/.test(String(err)));
});

test("isRecipientRefusal: the code AND the opening, never a keyword", () => {
  for (const m of RECIPIENT) assert.equal(isRecipientRefusal(-8, m), true, m.slice(0, 40));
  for (const [c, m] of WALLET_SIDE) assert.equal(isRecipientRefusal(c, m), false, `${c}: ${m.slice(0, 40)}`);
  assert.equal(isRecipientRefusal(-5, RECIPIENT[0]), false, "the right sentence under the wrong code is not trusted");
  assert.equal(isRecipientRefusal(-8, "something about a recipient address and the pool"), false, "words alone prove nothing");
});
