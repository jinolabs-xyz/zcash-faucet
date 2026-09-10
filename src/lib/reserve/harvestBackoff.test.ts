/**
 * The harvest flag during a BACKOFF window, which needs its own file because it needs
 * its own configuration.
 *
 * `harvesting` is set before the backoff check, so a tick the backoff suppresses used to
 * leave it true - up to twenty ticks at the cap - and /api/status reported a harvest in
 * progress with no step behind it. That is the same lie the yield path was fixed to stop
 * telling, one branch over.
 *
 * At the DEFAULT hourly interval the state is unreachable: a throw stamps the clock, so
 * nothing wants to harvest again until long after the backoff has cleared, and
 * ticksSinceAttempt only advances on ticks that wanted a step. It becomes reachable the
 * moment an operator shortens the interval, which is a supported setting - so that is
 * what this file configures. harvestWiring.test.ts cannot cover it: env is read once at
 * import and that file needs the hour.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

let hoshHeight: number | null = 4_220_000;
// 59_431 is shieldGateWiring's and 59_432/59_433 are taken too. The suites run as
// separate processes but bind the same loopback, so a duplicate here takes down the
// OTHER file, which is how this first showed up: a green file and a crashed neighbour.
const port = 59_430;
const hosh: Server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ servers: [{ chain: "test", online: true, height: hoshHeight }] }));
});
await new Promise<void>((r) => hosh.listen(port, "127.0.0.1", r));

process.env.HOSH_URL = `http://127.0.0.1:${port}/`;
process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:59997";
process.env.FAUCET_SENDER = "zallet";
process.env.ZALLET_ACCOUNT = "11111111-2222-3333-4444-555555555555";
process.env.ZALLET_ADDRESS = "utest1faucetunifiedaddressfixture";
process.env.ZALLET_RPC_URL = "http://127.0.0.1:59994/";
process.env.ZALLET_POLL_MS = "250";
process.env.FAUCET_SHIELD_COINBASE = "true";
process.env.FAUCET_RESERVE_LOW_TAZ = "5";
process.env.FAUCET_RESERVE_TARGET_TAZ = "15";
// The whole point of this file: short enough that a harvest falls due again while the
// backoff from the previous failure is still suppressing attempts.
process.env.FAUCET_HARVEST_INTERVAL_SECONDS = "1";
process.env.FAUCET_HARVEST_MIN_UTXOS = "50";

const { getReserveReconciler } = await import("./reconciler.ts");
const { getExternalTip, warmExternalTipNowForTests } = await import("../zcash/externalTip.ts");

const NETWORK_TIP = 4_220_000;
const RICH = "100" + "0".repeat(8);
const realFetch = globalThis.fetch;

before(async () => {
  hoshHeight = NETWORK_TIP;
  for (let i = 0; i < 40; i++) {
    await warmExternalTipNowForTests();
    if (getExternalTip() === NETWORK_TIP) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(getExternalTip(), NETWORK_TIP, "external tip must be primed");
});
after(() => {
  globalThis.fetch = realFetch;
  hosh.close();
});

test("a BACKED-OFF tick does not report a harvest in progress", async () => {
  // Every sweep throws, so failedSteps climbs and shouldAttempt starts suppressing ticks
  // while the one-second interval keeps saying a harvest is due.
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("59994")) return realFetch(url as string, init);
    const req = JSON.parse(String(init?.body)) as { method: string };
    if (req.method === "z_shieldcoinbase") {
      return new Response(
        JSON.stringify({ error: { code: -4, message: "Insufficient balance (have 0, need 10000 including fee)" } }),
        { status: 200 },
      );
    }
    const result =
      req.method === "getwalletstatus"
        ? { wallet_tip: { height: NETWORK_TIP }, node_tip: { height: NETWORK_TIP } }
        : req.method === "z_getbalanceforaccount"
          ? { pools: { orchard: { valueZat: RICH } } }
          : null;
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;

  const settle = async () => {
    for (let j = 0; j < 600 && getReserveReconciler().status.stepInFlight; j++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  // EVERY tick waits out the one-second interval first, so every tick genuinely wants to
  // harvest and a tick that attempts nothing was suppressed by the BACKOFF specifically.
  // Without the sleep the loop only ever sees interval-not-due ticks, which take the
  // yield path and clear the flag on their own - the first cut of this test asserted on
  // those and caught nothing. backoffTicks(1) is 1 and never suppresses, so suppression
  // begins at the second failure; seven ticks reaches it with room to spare.
  let suppressedSeen = 0;
  for (let i = 0; i < 7; i++) {
    await new Promise((r) => setTimeout(r, 1050));
    const before = getReserveReconciler().status.failedSteps;
    await getReserveReconciler().tick();
    await settle();
    const s = getReserveReconciler().status;
    if (s.failedSteps === before && s.failedSteps > 0) {
      suppressedSeen++;
      assert.equal(s.harvesting, false, `tick ${i} reported a harvest with no step behind it`);
    }
  }
  assert.ok(suppressedSeen > 0, "no backed-off tick was observed, so this asserted nothing");
  assert.ok(getReserveReconciler().status.failedSteps > 0, "the throws must be recorded");
});
