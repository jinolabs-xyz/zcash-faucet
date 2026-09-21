/**
 * LIVE MEANS "A DRIP PASSES THE WALLET-LAG GATE", and one function decides both.
 *
 * nodeStatus.ts used to decide readiness with `w >= n - 5` while /api/faucet decides a drip with
 * walletLagFreshness's budget of 10 (walletLagGate.ts). Two thresholds, nothing keeping them in
 * step, and the page's was stricter by half: in the 6-to-10 band /api/ready said NOT READY and
 * visitors were turned away from a drip the route would have served. These rows hold the page to
 * the gate's own predicate, so the band cannot open again without both numbers moving together.
 *
 * NOTHING OVERRIDDEN, on purpose (L: an override knob set in every case hides the default): this
 * file never sets FAUCET_WALLET_MAX_LAG_BLOCKS, so the boundary it measures is the shipped 10.
 * The one row that moves the budget does it in a child process, where the module loads fresh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// NO REAL ORACLE FROM A UNIT TEST: all three legs, before any import that loads config.
// Enforced by zcash/oraclePin.test.ts.
process.env.HOSH_URL = "http://127.0.0.1:9/";
process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:9";
process.env.TIP_ORACLE_ENDPOINT = "";
process.env.FAUCET_SENDER = "zallet";
process.env.ZALLET_RPC_URL = "http://127.0.0.1:9/";
assert.equal(process.env.FAUCET_WALLET_MAX_LAG_BLOCKS, undefined,
  "this file measures the SHIPPED budget; something set FAUCET_WALLET_MAX_LAG_BLOCKS before it ran");

const { getNodeStatus } = await import("./nodeStatus.ts");
const { mayBuildFromWallet, walletLagFreshness, WALLET_MAX_LAG_BLOCKS } = await import("./walletLagGate.ts");

/** One page read with the wallet `lag` blocks under a node at `n`, through the real function. */
async function readyAt(lag: number, n: number): Promise<boolean> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: { wallet_tip: { height: n - lag }, node_tip: { height: n } } }),
      { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const s = await getNodeStatus("claim");
    assert.ok(s, "the read must succeed for this row to measure anything");
    assert.ok(s.nodeHeight != null && s.height != null, "both heights must be present for the lag to mean anything");
    assert.equal(s.nodeHeight - s.height, lag, "the stub did not put the wallet where the row says");
    return s.ready;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// The node moves up one block per read so the motion check can never call it stalled.
const BASE = 4_374_000;
const LAGS = Array.from({ length: 21 }, (_, i) => i); // 0..20

test("the shipped budget is 10, read from the gate with nothing overridden", () => {
  assert.equal(WALLET_MAX_LAG_BLOCKS, 10);
});

test("readiness is the gate's own verdict at every lag from 0 to 20: served to 10, refused from 11", async () => {
  const served: number[] = [], refused: number[] = [], disagree: number[] = [];
  for (const lag of LAGS) {
    const n = BASE + lag;
    const ready = await readyAt(lag, n);
    const gate = mayBuildFromWallet(walletLagFreshness(n - lag, n));
    if (ready !== gate) disagree.push(lag);
    (ready ? served : refused).push(lag);
  }
  assert.deepEqual(disagree, [], `lags where the page and the drip gate disagree: ${disagree.join(", ")} - two thresholds again`);
  assert.deepEqual(served, LAGS.filter((l) => l <= WALLET_MAX_LAG_BLOCKS),
    `served ${served.length} of ${LAGS.length} lags (${served.join(",")}); the gate serves 0..${WALLET_MAX_LAG_BLOCKS}`);
  assert.deepEqual(refused, LAGS.filter((l) => l > WALLET_MAX_LAG_BLOCKS),
    `refused ${refused.length} of ${LAGS.length} lags (${refused.join(",")}); the gate refuses from ${WALLET_MAX_LAG_BLOCKS + 1}`);
});

test("the 6-to-10 band is SERVED, which is the band the old rule refused, and 11 is still refused", async () => {
  // Named on its own so the mutant that restores `w >= n - 5` fails a row that says why.
  for (const lag of [6, 7, 8, 9, 10]) {
    assert.equal(await readyAt(lag, BASE + 100 + lag), true, `lag ${lag}: inside the drip budget, yet the page refuses`);
  }
  assert.equal(await readyAt(11, BASE + 200), false, "lag 11: over the budget, yet the page says LIVE");
});

test("moving the budget moves the page with it - one number, in a fresh process", () => {
  // WALLET_MAX_LAG_BLOCKS is fixed at module load, so the override is measured in a child that
  // loads the modules under it. 15 and 16 are the boundary that only a moved budget produces.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const script = `
    process.env.HOSH_URL = "http://127.0.0.1:9/"; process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:9";
    process.env.TIP_ORACLE_ENDPOINT = ""; process.env.FAUCET_SENDER = "zallet"; process.env.ZALLET_RPC_URL = "http://127.0.0.1:9/";
    const { getNodeStatus } = await import(${JSON.stringify(here + "nodeStatus.ts")});
    const out = [];
    for (const [lag, n] of [[15, 4374400], [16, 4374401]]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ result: { wallet_tip: { height: n - lag }, node_tip: { height: n } } }), { status: 200, headers: { "content-type": "application/json" } });
      const s = await getNodeStatus("claim");
      out.push(lag + ":" + (s ? s.ready : "null"));
    }
    console.log(out.join(" "));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "--eval", script],
    { env: { ...process.env, FAUCET_WALLET_MAX_LAG_BLOCKS: "15" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  const line = out.trim().split("\n").pop();
  assert.equal(line, "15:true 16:false", `with the budget at 15 the page must serve 15 and refuse 16, read: ${line}`);
});

test("a height that is present but not a number is nothing: the read fails closed for the page AND the drip", async () => {
  // CTO's red-team of round one: wallet_tip.height "abc" passed `?? null`, the gate computed NaN,
  // and NaN is neither over the budget nor under it, so it fell through to safe - LIVE on the
  // page, and the drip served. The parse is the one place both consumers read the number.
  const realFetch = globalThis.fetch;
  const { resetNodeStatusFailures } = await import("./nodeStatusFailure.ts");
  for (const [label, wallet, node] of [["wallet_tip", "abc", 4_375_000], ["node_tip", 4_374_997, "abc"], ["wallet_tip float-looking", "4374997", 4_375_000]] as const) {
    resetNodeStatusFailures();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: { wallet_tip: { height: wallet }, node_tip: { height: node } } }),
        { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const s = await getNodeStatus("claim");
      assert.equal(s, null, `${label} as a string must make the read fail, not a verdict: read ${JSON.stringify(s && { ready: s.ready, height: s.height, nodeHeight: s.nodeHeight })}`);
      // and the drip's own gate, fed what the route feeds it from a failed read (both null), refuses too
      const gate = walletLagFreshness(null, null);
      assert.equal(gate.state, "unverifiable", `${label}: the gate must be unverifiable on a failed read, was ${gate.state}`);
      assert.equal(mayBuildFromWallet(gate), false);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

test("and a real integer height still reads: the check refuses shapes, not numbers", async () => {
  assert.equal(await readyAt(3, BASE + 300), true, "lag 3 with integer heights must still be LIVE");
});
