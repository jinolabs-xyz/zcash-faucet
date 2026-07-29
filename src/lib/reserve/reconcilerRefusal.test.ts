/**
 * What the reconciler does with a refusal, which is the half of the gate an
 * operator actually experiences.
 *
 * Two things have to hold, and neither is provable from the refiller alone:
 *
 *   1. A refusal is SAID, every tick, not once at the transition. The whole cost
 *      of #172 was sixteen hours of a stalled loop reading like an idle one, and
 *      a refusal stalls it exactly the same way while looking healthier: the
 *      config is right, shielding is on, and nothing moves.
 *   2. A refusal never lands in emptySweeps. That counter drives "coinbase EXISTS
 *      but this account cannot spend it", which would point an operator at the
 *      miner address while the real fault is a stale chain view.
 *
 * Asserted against the real reconciler through a real send queue with a real
 * ZalletRefiller, over a fake wallet. Sabotaging the reconciler's refusal branch
 * has to fail this file, and reimplementing the branch here would mean it does not.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

let hoshHeight: number | null = 4_220_000;
const port = 59_432;
const hosh: Server = createServer((_req, res) => {
  if (hoshHeight == null) {
    res.writeHead(503).end("{}");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ servers: [{ chain: "test", online: true, height: hoshHeight }] }));
});
await new Promise<void>((r) => hosh.listen(port, "127.0.0.1", r));

process.env.HOSH_URL = `http://127.0.0.1:${port}/`;
process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:59997";
process.env.FAUCET_SENDER = "zallet";
process.env.ZALLET_ACCOUNT = "11111111-2222-3333-4444-555555555555";
process.env.ZALLET_ADDRESS = "utest1faucetunifiedaddressfixture";
process.env.ZALLET_RPC_URL = "http://127.0.0.1:59996/";
process.env.ZALLET_POLL_MS = "250";
// Shielding PERMITTED, so a refusal is the only thing left that can stop a sweep.
// Without this the loop declines earlier, at canAct, and this file would pass
// while proving nothing about the gate.
process.env.FAUCET_SHIELD_COINBASE = "true";
process.env.FAUCET_RESERVE_LOW_TAZ = "5";
process.env.FAUCET_RESERVE_TARGET_TAZ = "15";

const { getReserveReconciler } = await import("./reconciler.ts");
const { getExternalTip, warmExternalTip } = await import("../zcash/externalTip.ts");

const NETWORK_TIP = 4_220_000;
const BROKE = "1" + "0".repeat(8); // 1 TAZ in zatoshi, under the 5 TAZ low mark

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

/** A wallet that is broke (so the loop wants to refill) and willing to shield. */
function mockWallet(nodeHeight: number) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("59996")) return realFetch(url as string, init);
    const req = JSON.parse(String(init?.body)) as { method: string };
    calls.push(req.method);
    const result =
      req.method === "getwalletstatus"
        ? { wallet_tip: { height: nodeHeight }, node_tip: { height: nodeHeight } }
        : req.method === "z_getbalanceforaccount"
          ? { pools: { orchard: { valueZat: BROKE } } }
          : req.method === "z_shieldcoinbase"
            ? { opid: "opid-shield", remainingUTXOs: 4 }
            : req.method === "z_getoperationstatus" || req.method === "z_getoperationresult"
              ? [{ id: "opid-shield", status: "success" }]
              : null;
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

/** Capture console.error while a tick runs, so "logged loudly" is an assertion. */
async function tickCapturingErrors(): Promise<string[]> {
  const lines: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await getReserveReconciler().tick();
    // The step runs through the queue after the tick resolves, so give the
    // promise chain a turn. Without this the assertions race the log line.
    for (let i = 0; i < 20 && !lines.some((l) => l.includes("REFUSED")); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    console.error = realError;
  }
  return lines;
}

before(() => primeTip(NETWORK_TIP));
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => hosh.close());

test("a stale node makes the loop SAY it refused, with the reason and the lag", async () => {
  mockWallet(NETWORK_TIP - 40); // the #172 lag exactly

  const lines = await tickCapturingErrors();
  const refusal = lines.find((l) => l.includes("REFUSED"));

  assert.ok(refusal, `no refusal logged. lines were: ${JSON.stringify(lines)}`);
  assert.match(refusal!, /state=unsafe/);
  assert.match(refusal!, /lag=40/);
  assert.match(refusal!, /40 blocks behind the network/, "the operator gets the reason, not just a state");
  assert.match(refusal!, /cannot recover on its own/, "and is told the balance will not fix itself");

  const status = getReserveReconciler().status;
  assert.equal(status.refilling, true, "still wants to refill");
  assert.equal(status.shieldRefusals, 1);
  assert.equal(status.lastRefusal?.state, "unsafe");
  // The whole point. remainingUTXOs=4 above would read as the 47.5 TAZ shape.
  assert.equal(status.emptySweeps, 0, "a refusal is not a sweep that found nothing");
});

test("a refusal is repeated every tick, not announced once and then silent", async () => {
  mockWallet(NETWORK_TIP - 40);
  const second = await tickCapturingErrors();
  assert.ok(
    second.some((l) => l.includes("REFUSED")),
    "the second consecutive refusal must still be audible",
  );
  const status = getReserveReconciler().status;
  assert.equal(status.shieldRefusals, 2, "and it counts, so the run length is visible");
  assert.equal(status.emptySweeps, 0);
});

test("the gate clearing lets the same loop sweep, and resets the refusal count", async () => {
  const calls = mockWallet(NETWORK_TIP);

  const lines = await tickCapturingErrors();

  assert.ok(!lines.some((l) => l.includes("REFUSED")), "nothing to refuse once the node is current");
  assert.ok(calls.includes("z_shieldcoinbase"), "the sweep actually reached the wallet");
  const status = getReserveReconciler().status;
  assert.equal(status.shieldRefusals, 0);
  assert.equal(status.lastRefusal, null);
  assert.equal(status.remainingUTXOs, 4);
});
