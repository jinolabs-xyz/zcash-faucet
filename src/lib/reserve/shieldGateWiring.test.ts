/**
 * The gate is only real if something declines to call the RPC. shieldGate.test.ts
 * proves the DECISION is right; this proves the BROADCAST obeys it, which is the
 * half that could ship green while a shield still went out (#171 + #172).
 *
 * So the assertion that matters in here is never "step() returned refused". It is
 * that `z_shieldcoinbase` is ABSENT from the recorded wire calls. A refusal that
 * returns the right object after broadcasting is the exact bug this file exists to
 * catch, and only the call log can tell the two apart.
 *
 * Nothing is stubbed at the module level. The tip comes from a real HTTP server
 * through externalTip's real parser and cache, and the node height comes from a
 * real getwalletstatus response, because a test that reimplements the gate's
 * inputs certifies a paraphrase (CONTRIBUTING rule 15).
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

// A fake hosh aggregate, so getExternalTip() has a real source to parse. Height
// is mutable: null makes the endpoint fail, which is how the "no independent tip"
// state gets reached without waiting out MAX_AGE_MS.
let hoshHeight: number | null = null;
const port = 59_431;

const hosh: Server = createServer((_req, res) => {
  if (hoshHeight == null) {
    res.writeHead(503).end("{}");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ servers: [{ chain: "test", online: true, height: hoshHeight }] }));
});
await new Promise<void>((r) => hosh.listen(port, "127.0.0.1", r));

// Env before the dynamic imports: config and HOSH_URL are both read at module load.
// The lightwalletd fallback is pointed at a closed port rather than cleared, since
// an empty list falls back to the real testnet endpoint and would quietly supply a
// tip this test did not choose.
process.env.HOSH_URL = `http://127.0.0.1:${port}/`;
process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:59997";
process.env.FAUCET_SENDER = "zallet";
process.env.ZALLET_ACCOUNT = "11111111-2222-3333-4444-555555555555";
process.env.ZALLET_ADDRESS = "utest1faucetunifiedaddressfixture";
process.env.ZALLET_RPC_URL = "http://127.0.0.1:59998/";
process.env.ZALLET_POLL_MS = "250";

const { ZalletRefiller } = await import("./zalletRefiller.ts");
const { SHIELD_MAX_LAG_BLOCKS } = await import("../zcash/shieldGate.ts");
const { getExternalTip, warmExternalTip } = await import("../zcash/externalTip.ts");
const { classifySweep } = await import("./decide.ts");

const NETWORK_TIP = 4_220_000;

/**
 * Drive the real cache to a known value. Loops because getExternalTip() kicks
 * background refreshes of its own and warmExternalTip() returns early while one
 * is in flight, so a single await can silently no-op. Asserting the value landed
 * is what keeps the safe/unsafe split from depending on timing.
 */
async function primeTip(height: number | null): Promise<void> {
  hoshHeight = height;
  for (let i = 0; i < 40; i++) {
    await warmExternalTip();
    if (getExternalTip() === height) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`could not prime the external tip to ${height} (still ${getExternalTip()})`);
}

const realFetch = globalThis.fetch;

/**
 * Fake zallet endpoint. Anything that is not our RPC URL goes to the real fetch,
 * so the tip server keeps working while the wallet is mocked.
 */
function mockWallet(nodeHeight: number | null, handlers: Record<string, (p: unknown[]) => unknown> = {}) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("59998")) return realFetch(url as string, init);
    const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push({ method: req.method, params: req.params });
    if (req.method === "getwalletstatus") {
      // nodeHeight null models a wallet that answers but reports no tip. The
      // unreachable case is covered separately by refusing the connection.
      if (nodeHeight == null) return new Response(JSON.stringify({ result: {} }), { status: 200 });
      return new Response(
        JSON.stringify({ result: { wallet_tip: { height: nodeHeight }, node_tip: { height: nodeHeight } } }),
        { status: 200 },
      );
    }
    const h = handlers[req.method];
    if (!h) return new Response(JSON.stringify({ error: { code: -32601, message: `no handler for ${req.method}` } }), { status: 200 });
    return new Response(JSON.stringify({ result: h(req.params) }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

/** A wallet that shields successfully, so a refusal is the only thing that can stop it. */
const WILLING_WALLET = {
  z_shieldcoinbase: () => ({ opid: "opid-shield", remainingUTXOs: 0 }),
  z_getoperationstatus: () => [{ id: "opid-shield", status: "success" }],
  z_getoperationresult: () => [{ id: "opid-shield", status: "success" }],
};

before(async () => {
  // Start with NO verifiable tip. This test runs first on purpose: the cache is
  // process-global and holds a value for five minutes once warmed, so the
  // "cannot verify" state is only reachable before anything primes it.
  await primeTip(null);
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => hosh.close());

test("no independent tip means UNVERIFIABLE, and unverifiable does not broadcast", async () => {
  assert.equal(getExternalTip(), null, "precondition: the tip oracle has nothing to say");
  const calls = mockWallet(NETWORK_TIP, WILLING_WALLET);

  const outcome = await new ZalletRefiller().step();

  assert.equal(outcome.moved, false);
  assert.equal(outcome.refused?.state, "unverifiable");
  // The one that matters. The wallet above would have shielded happily.
  assert.ok(
    !calls.some((c) => c.method === "z_shieldcoinbase"),
    "a node we cannot verify must not reach the broadcast",
  );
});

test("a wallet that reports no height is unverifiable too, not a pass", async () => {
  const calls = mockWallet(null, WILLING_WALLET);
  const outcome = await new ZalletRefiller().step();
  assert.equal(outcome.refused?.state, "unverifiable");
  assert.ok(!calls.some((c) => c.method === "z_shieldcoinbase"));
});

test("an unreachable wallet refuses rather than throwing past the gate", async () => {
  // Real fetch at a closed port: getNodeStatus returns null, so there is no
  // status object to read a gate off. That must fail closed, not skip the check.
  globalThis.fetch = realFetch;
  const outcome = await new ZalletRefiller().step();
  assert.equal(outcome.moved, false);
  assert.equal(outcome.refused?.state, "unverifiable");
});

test("a node behind the network is UNSAFE and does not broadcast", async () => {
  await primeTip(NETWORK_TIP);
  const lagging = NETWORK_TIP - (SHIELD_MAX_LAG_BLOCKS + 1);
  const calls = mockWallet(lagging, WILLING_WALLET);

  const outcome = await new ZalletRefiller().step();

  assert.equal(outcome.refused?.state, "unsafe");
  assert.equal(outcome.refused?.lag, SHIELD_MAX_LAG_BLOCKS + 1);
  assert.ok(!calls.some((c) => c.method === "z_shieldcoinbase"), "a stale node must not build a transaction");
});

test("the #172 lag of 40 blocks is refused, since that is the height that killed tx 29", async () => {
  await primeTip(4_217_981);
  const calls = mockWallet(4_217_941, WILLING_WALLET);
  const outcome = await new ZalletRefiller().step();
  assert.equal(outcome.refused?.state, "unsafe");
  assert.equal(outcome.refused?.lag, 40);
  assert.ok(!calls.some((c) => c.method === "z_shieldcoinbase"));
});

test("a node in step with the network DOES broadcast", async () => {
  // Without this the suite would pass on a gate that refuses everything, which
  // is the failure mode a fail-closed change introduces (#171 block condition:
  // every state reachable AND asserted).
  await primeTip(NETWORK_TIP);
  const calls = mockWallet(NETWORK_TIP, WILLING_WALLET);

  const outcome = await new ZalletRefiller().step();

  assert.equal(outcome.moved, true);
  assert.equal(outcome.refused, undefined);
  const shield = calls.find((c) => c.method === "z_shieldcoinbase");
  assert.ok(shield, "a fresh node must still be able to shield");
  assert.deepEqual(shield!.params, [
    "11111111-2222-3333-4444-555555555555",
    "utest1faucetunifiedaddressfixture",
    null,
    50,
  ]);
});

test("lag inside the budget still broadcasts, so the gate is not just an off switch", async () => {
  await primeTip(NETWORK_TIP);
  const calls = mockWallet(NETWORK_TIP - SHIELD_MAX_LAG_BLOCKS, WILLING_WALLET);
  const outcome = await new ZalletRefiller().step();
  assert.equal(outcome.moved, true, `lag of exactly ${SHIELD_MAX_LAG_BLOCKS} is within budget`);
  assert.ok(calls.some((c) => c.method === "z_shieldcoinbase"));
});

test("a refusal is never classified as a sweep that found nothing", async () => {
  // The reconciler counts empty sweeps and blames the miner address for a run of
  // them. A refusal reaching that path would send an operator after the wrong
  // fault entirely, so the verdict has to stay distinct end to end.
  await primeTip(NETWORK_TIP);
  mockWallet(NETWORK_TIP - 100, WILLING_WALLET);
  const outcome = await new ZalletRefiller().step();
  assert.equal(classifySweep(outcome), "refused");
  assert.notEqual(classifySweep(outcome), "count-not-reported");
});

test("a sweep with nothing eligible is still a clean no-op behind a passing gate", async () => {
  // Moved from zcash/zallet.test.ts. `calls.length === 2` is getwalletstatus plus
  // the sweep itself: the gate costs exactly one extra round-trip and the absence
  // of an opid still means no polling.
  await primeTip(NETWORK_TIP);
  const calls = mockWallet(NETWORK_TIP, {
    z_shieldcoinbase: () => ({ remainingUTXOs: 0 }), // no opid: nothing eligible
  });
  const outcome = await new ZalletRefiller().step();
  assert.equal(outcome.moved, false);
  assert.equal(outcome.refused, undefined, "an empty sweep is not a refusal");
  assert.equal(outcome.remainingUTXOs, 0);
  assert.equal(calls.length, 2, "no polling without an opid");
  assert.equal(classifySweep(outcome), "nothing-visible");
});

test("a shield that lands is polled to its final result", async () => {
  // Also moved from zcash/zallet.test.ts: the opid lifecycle is unchanged by the
  // gate, and it needs to stay asserted somewhere.
  await primeTip(NETWORK_TIP);
  let statusPolls = 0;
  const calls = mockWallet(NETWORK_TIP, {
    z_shieldcoinbase: () => ({ opid: "opid-shield", shieldingUTXOs: 3 }),
    z_getoperationstatus: () => [{ id: "opid-shield", status: ++statusPolls < 2 ? "queued" : "success" }],
    z_getoperationresult: () => [{ id: "opid-shield", status: "success" }],
  });
  await new ZalletRefiller().step();
  assert.ok(statusPolls >= 2, "polled while queued instead of reaping early");
  assert.ok(calls.some((c) => c.method === "z_getoperationresult"), "collected the final result");
});
