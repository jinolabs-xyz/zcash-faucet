/**
 * What the RECONCILER does with the harvest trigger, which is the half that
 * actually broadcasts.
 *
 * decide.test.ts covers the predicate. It cannot cover the wiring, and the wiring
 * is where the money is: review of the first cut found that deleting the clock
 * stamp, or replacing the whole `shouldHarvest(...)` call with `true`, left every
 * one of 716 tests passing while turning the loop into an unconditional shield
 * broadcast every 30 seconds. A predicate nobody calls correctly is a predicate
 * nobody has tested.
 *
 * So these drive the real reconciler, through the real send queue, with the real
 * ZalletRefiller, over a fake wallet - the same shape as reconcilerRefusal.test.ts.
 * Counting z_shieldcoinbase calls is the assertion, because that is the thing that
 * costs a fee and the thing #172 was about.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

let hoshHeight: number | null = 4_220_000;
const port = 59_433;
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
process.env.ZALLET_RPC_URL = "http://127.0.0.1:59995/";
process.env.ZALLET_POLL_MS = "250";
process.env.FAUCET_SHIELD_COINBASE = "true";
// RICH: comfortably above target, so `refilling` is false and every sweep these
// tests see was started by HARVEST. Without this the refill trigger would explain
// the sweeps and the file would prove nothing about the thing it is named for.
process.env.FAUCET_RESERVE_LOW_TAZ = "5";
process.env.FAUCET_RESERVE_TARGET_TAZ = "15";
process.env.FAUCET_HARVEST_INTERVAL_SECONDS = "3600";
process.env.FAUCET_HARVEST_MIN_UTXOS = "50";

const { getReserveReconciler } = await import("./reconciler.ts");
const { getExternalTip, warmExternalTipNowForTests } = await import("../zcash/externalTip.ts");

const NETWORK_TIP = 4_220_000;
const RICH = "100" + "0".repeat(8); // 100 TAZ, far above the 15 TAZ target

async function primeTip(height: number | null): Promise<void> {
  hoshHeight = height;
  for (let i = 0; i < 40; i++) {
    await warmExternalTipNowForTests();
    if (getExternalTip() === height) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`could not prime the external tip to ${height} (still ${getExternalTip()})`);
}

const realFetch = globalThis.fetch;

interface WalletOpts {
  /** UTXOs the wallet claims are left after each sweep. */
  remainingUTXOs: number;
  /** Whether a sweep returns an opid, i.e. whether anything actually moved. */
  moves: boolean;
  /** Make the BALANCE call fail while the status call still answers. */
  balanceBlind?: boolean;
}

function mockWallet(o: WalletOpts) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("59995")) return realFetch(url as string, init);
    const req = JSON.parse(String(init?.body)) as { method: string };
    calls.push(req.method);
    if (req.method === "z_getbalanceforaccount" && o.balanceBlind) {
      return new Response(JSON.stringify({ error: { code: -1, message: "wallet busy" } }), { status: 200 });
    }
    const result =
      req.method === "getwalletstatus"
        ? { wallet_tip: { height: NETWORK_TIP }, node_tip: { height: NETWORK_TIP } }
        : req.method === "z_getbalanceforaccount"
          ? { pools: { orchard: { valueZat: RICH } } }
          : req.method === "z_shieldcoinbase"
            ? o.moves
              ? { opid: "opid-shield", remainingUTXOs: o.remainingUTXOs }
              : { remainingUTXOs: o.remainingUTXOs }
            : req.method === "z_getoperationstatus" || req.method === "z_getoperationresult"
              ? [{ id: "opid-shield", status: "success" }]
              : null;
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

/** Run n ticks and let each queued step settle. Returns the z_shieldcoinbase count. */
async function runTicks(calls: string[], n: number): Promise<number> {
  for (let i = 0; i < n; i++) {
    await getReserveReconciler().tick();
    // The step runs through the queue AFTER the tick resolves, so wait for it to
    // finish. This condition used to read `status.refilling === undefined`, which is
    // typed boolean and therefore never true - the loop never ran once and the whole
    // settle was a fixed 60 ms sleep. Adding 120 ms per RPC to the mock (a slow but
    // perfectly healthy wallet, or a loaded CI box) broke two tests and, worse, made
    // the two `<=` assertions pass MORE easily: a step still in flight suppresses the
    // next tick's sweep, which looks exactly like the guard working.
    for (let j = 0; j < 600 && getReserveReconciler().status.stepInFlight; j++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(getReserveReconciler().status.stepInFlight, false, "step did not settle in 3s");
  }
  return calls.filter((m) => m === "z_shieldcoinbase").length;
}

before(() => primeTip(NETWORK_TIP));
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => hosh.close());

/*
 * ORDER MATTERS HERE, and the file says so because it already caught me.
 *
 * The reconciler is a globalThis singleton, so lastHarvestAt, remainingUTXOs and
 * lastSweepMoved carry from one test to the next. The blind test originally ran
 * LAST and passed with the guard deleted: a recent clock from the earlier sweeps
 * suppressed the harvest on its own, so it was asserting nothing. It runs first,
 * on pristine state, and every test below asserts the preconditions it depends on
 * rather than trusting the order to hold.
 */

test("A BLIND LOOP DOES NOT BROADCAST, even on the very first tick", async () => {
  // getwalletstatus answers so the shield gate is satisfied; the balance call does
  // not. safeBalance swallows that, and a fresh process has a null harvest clock,
  // which read as due. Review measured three blind ticks, three broadcasts.
  // PRECONDITIONS, or this passes on inherited state instead of on the guard: a
  // null clock is what makes the probe due, and a null count is what a fresh
  // process has. Both are true only before any sweep has run.
  assert.equal(getReserveReconciler().status.harvestAgeSeconds, null, "clock must be pristine");
  assert.equal(getReserveReconciler().status.remainingUTXOs, null, "count must be unknown");
  const calls = mockWallet({ remainingUTXOs: 1346, moves: true, balanceBlind: true });
  const sweeps = await runTicks(calls, 3);
  assert.equal(sweeps, 0, "a loop that cannot read its balance must not move money");
  assert.equal(getReserveReconciler().status.spendableTaz, null);
});

test("A REFUSAL DOES NOT ADVANCE THE HARVEST CLOCK: the wallet was never asked", async () => {
  // The count rule and the clock rule are the same rule. The gate answers before the
  // wallet is reached, so a refused tick consumed no interval - but the stamp was
  // written at the ATTEMPT, before the outcome was known. One lag blip at the moment an
  // hourly harvest fell due then cost the whole hour, with the work still sitting there.
  // PRECONDITION: a null clock. It is what makes this the interval path rather than the
  // backlog path, and the backlog path would fire regardless of the clock and prove
  // nothing. Only true before any sweep, hence the position directly after the blind test.
  assert.equal(getReserveReconciler().status.harvestAgeSeconds, null, "clock must be pristine");

  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("59995")) return realFetch(url as string, init);
    const req = JSON.parse(String(init?.body)) as { method: string };
    calls.push(req.method);
    const stale = NETWORK_TIP - 40;
    const result =
      req.method === "getwalletstatus"
        ? { wallet_tip: { height: stale }, node_tip: { height: stale } }
        : req.method === "z_getbalanceforaccount"
          ? { pools: { orchard: { valueZat: RICH } } }
          : null;
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;

  const sweeps = await runTicks(calls, 2);
  assert.equal(sweeps, 0, "a refused tick must not reach z_shieldcoinbase");
  assert.ok(getReserveReconciler().status.shieldRefusals > 0, "the gate should have refused");
  // null, not 0. A stamped clock reads 0 here, and 0 means "harvested just now".
  assert.equal(
    getReserveReconciler().status.harvestAgeSeconds,
    null,
    "a refusal must leave the clock alone: no interval was spent",
  );
});

test("A DRAINING BACKLOG SWEEPS ON CONSECUTIVE TICKS, which is what makes a drain a drain", async () => {
  // Moving, and 1346 left: 1346 UTXOs at one batch an hour is a day and a half.
  const calls = mockWallet({ remainingUTXOs: 1346, moves: true });
  const sweeps = await runTicks(calls, 4);
  assert.ok(sweeps >= 3, `expected repeated sweeps while draining, saw ${sweeps}`);
  assert.equal(getReserveReconciler().status.refilling, false, "refill must not explain these sweeps");
});

test("A REFUSAL DOES NOT ERASE THE KNOWN BACKLOG, so one blip does not stall the drain", async () => {
  // A refusal carries no count - the wallet was never asked - so writing null over a
  // known 1346 turns "we did not look" into "there is nothing there". Review measured
  // the cost: one 40-block lag blip, then a full recovery, then ZERO sweeps for the
  // rest of the interval with the work still waiting.
  // PRECONDITIONS. A refusal can only be observed if a harvest actually fires, and
  // only the draining state does that - hence the position in this file. The pinned
  // test below sets lastSweepMoved false, after which nothing fires and this would
  // assert on a tick that never happened.
  assert.equal(getReserveReconciler().status.remainingUTXOs, 1346, "a count must be known");
  assert.equal(getReserveReconciler().status.harvesting, true, "a harvest must be live to refuse");

  // The #172 lag exactly: status answers, the gate refuses.
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("59995")) return realFetch(url as string, init);
    const req = JSON.parse(String(init?.body)) as { method: string };
    calls.push(req.method);
    const stale = NETWORK_TIP - 40;
    const result =
      req.method === "getwalletstatus"
        ? { wallet_tip: { height: stale }, node_tip: { height: stale } }
        : req.method === "z_getbalanceforaccount"
          ? { pools: { orchard: { valueZat: RICH } } }
          : null;
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;

  await runTicks(calls, 2);
  assert.ok(getReserveReconciler().status.shieldRefusals > 0, "the gate should have refused");
  assert.equal(
    getReserveReconciler().status.remainingUTXOs,
    1346,
    "a refusal must leave the count alone: it is not evidence about coinbase",
  );
});

test("A STEP THAT THROWS ENDS THE BACKLOG PATH, or the drain never terminates", async () => {
  // The progress guard is cleared in .then, which a throwing step never reaches: with
  // lastSweepMoved latched true and remainingUTXOs deliberately left alone, `draining`
  // stayed true forever and the loop re-attempted on every tick the backoff allowed,
  // settling at the backoff cap instead of the hourly interval. The throw that does it is
  // the routine one on the live box - "Insufficient balance (have 0, need 10000 including
  // fee)" - which is exactly how a drain ENDS, so this is the normal case, not a rare one.
  const draining = mockWallet({ remainingUTXOs: 1346, moves: true });
  assert.ok((await runTicks(draining, 1)) >= 1, "the backlog path must be live first");
  assert.equal(getReserveReconciler().status.remainingUTXOs, 1346);

  // Now the mature coinbase runs out and the RPC starts throwing.
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("59995")) return realFetch(url as string, init);
    const req = JSON.parse(String(init?.body)) as { method: string };
    calls.push(req.method);
    if (req.method === "z_shieldcoinbase") {
      return new Response(
        JSON.stringify({
          error: { code: -4, message: "Insufficient balance (have 0, need 10000 including fee)" },
        }),
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

  // Twelve ticks is chosen so the BACKOFF alone cannot explain the result: it lets
  // roughly four attempts through at these failure counts, and the interval lets none.
  const sweeps = await runTicks(calls, 12);
  assert.ok(sweeps <= 1, `a throwing sweep must fall back to the interval, saw ${sweeps} in 12`);
  assert.ok(getReserveReconciler().status.failedSteps > 0, "the throw must be recorded");
  // And nothing claims to be running. The flag is set before the backoff check, so a
  // suppressed tick used to leave it true for the whole window - up to twenty ticks -
  // and /api/status reported a harvest in progress with no step behind it.
  assert.equal(
    getReserveReconciler().status.harvesting,
    false,
    "a backed-off tick must not report a harvest in progress",
  );
});

test("A PINNED COUNT DOES NOT SWEEP EVERY TICK, which is the fee loop", async () => {
  // Nothing moves and the count stays high: coinbase that is not mature yet, which
  // is the ROUTINE state on a mining faucet, or #172's unspendable shape. Review
  // measured 20 ticks -> 20 broadcasts here before the progress guard.
  const calls = mockWallet({ remainingUTXOs: 1346, moves: false });
  const sweeps = await runTicks(calls, 6);
  assert.ok(sweeps <= 1, `a pinned count must not sweep every tick, saw ${sweeps} in 6`);
  // And the flag tells the truth about it. `harvesting` was assigned only after the
  // decision to run a step, so on every tick that yielded it kept its previous value
  // and /api/status reported a harvest in progress through the whole stall.
  assert.equal(
    getReserveReconciler().status.harvesting,
    false,
    "a loop that is not sweeping must not report that it is",
  );
});
