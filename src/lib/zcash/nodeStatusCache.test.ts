import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cachedNodeStatus,
  cachedNodeStatusAgeMs,
  nodeStatusForPage,
  refreshNodeStatusForTests,
  resetNodeStatusCacheForTests,
  NODE_STATUS_MAX_AGE_MS,
} from "./nodeStatusCache.ts";
import { getNodeStatus } from "./nodeStatus.ts";

const realFetch = globalThis.fetch;

/** A wallet that answers the getwalletstatus shape after `delayMs`, or fails. */
function wallet(opts: { heights?: [number, number]; delayMs?: number; fail?: boolean }) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fail) throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" });
    const [w, n] = opts.heights ?? [1_000_000, 1_000_000];
    return new Response(JSON.stringify({ result: { wallet_tip: { height: w }, node_tip: { height: n } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls: () => calls };
}

function restore() {
  globalThis.fetch = realFetch;
  resetNodeStatusCacheForTests();
}

test("a WARM read does not wait for the wallet - which is the whole point of this module", async () => {
  // The defect: /api/status did Promise.all over three reads, so the slowest gated all of them and
  // the balance waited on a height nobody was looking at. Measured on prod: that read refused 11.27%
  // of the time with a tail to ~10s.
  resetNodeStatusCacheForTests();
  wallet({ delayMs: 0 });
  await refreshNodeStatusForTests(); // the cache is now warm
  wallet({ delayMs: 400 }); // and the wallet has since gone slow
  const t0 = Date.now();
  const s = await nodeStatusForPage(Date.now() + 5_000); // stale enough to trigger a refresh
  const tookMs = Date.now() - t0;
  restore();
  assert.ok(s !== null, "a warm cache returned nothing");
  assert.ok(tookMs < 150, `the response waited ${tookMs}ms on a 400ms wallet - it is still on the request path`);
});

test("a FAILED refresh does not clear a good reading", async () => {
  // Overwriting a 3-second-old reading with the null of one failed read would flicker the card to
  // unknown on a single wobble, which is the failure this cache exists to absorb.
  resetNodeStatusCacheForTests();
  wallet({ heights: [900_000, 900_000] });
  await refreshNodeStatusForTests();
  const before = cachedNodeStatus();
  assert.ok(before !== null && before.nodeHeight === 900_000);
  wallet({ fail: true });
  await refreshNodeStatusForTests();
  const after = cachedNodeStatus();
  restore();
  assert.ok(after !== null, "a failed read wiped the cached reading");
  assert.equal(after.nodeHeight, 900_000, "the good reading was replaced by a failure");
});

test("past MAX_AGE it says nothing rather than serving a stale reading as current", async () => {
  // A cache nobody refreshes must age out. The alternative is a reading old enough to describe a
  // different chain state, wearing a current timestamp.
  resetNodeStatusCacheForTests();
  wallet({});
  await refreshNodeStatusForTests();
  const now = Date.now();
  assert.ok(cachedNodeStatus(now) !== null, "fresh reading was not served");
  const stale = cachedNodeStatus(now + NODE_STATUS_MAX_AGE_MS + 1);
  const age = cachedNodeStatusAgeMs(now + NODE_STATUS_MAX_AGE_MS + 1);
  restore();
  assert.equal(stale, null, "a reading past MAX_AGE was served as though current");
  assert.equal(age, null, "an aged-out reading still reported an age");
});

test("canBuildTx is RECOMPUTED on every serve, never copied out of the cache", async () => {
  // @SDE-Research, shooting at this design before it was code: canBuildTx is not a display field,
  // it is the send gate's verdict and faucetPhase.ts:146 ACTS on it. A cached `true` served while
  // the real answer is `false` shows a ready page, takes the visitor's proof-of-work, and then
  // /api/faucet refuses them - #457 through a different door.
  //
  // THIS ROW PLANTS A CONTRADICTORY VERDICT IN THE CELL rather than comparing the served value to a
  // recomputation of itself. readChainFreshness reads referenceTip() - the oracle's cache - so in a
  // test where the tip never moves, "recomputed" and "copied" produce the same answer and the
  // comparison cannot fail. Planting the opposite value is what makes the two behaviours separable.
  resetNodeStatusCacheForTests();
  wallet({ heights: [1_000_000, 1_000_000] });
  await refreshNodeStatusForTests();
  const { readChainFreshness, mayBuildTransaction } = await import("./shieldGate.ts");
  const cell = (globalThis as unknown as { __nodeStatusCache?: { status: { nodeHeight: number | null; canBuildTx: boolean } | null } }).__nodeStatusCache;
  assert.ok(cell?.status, "nothing was cached, so this row would measure nothing");
  const live = mayBuildTransaction(readChainFreshness(cell.status.nodeHeight));
  cell.status.canBuildTx = !live; // a stale verdict, of the shape that would take a visitor's PoW
  const served = cachedNodeStatus();
  restore();
  assert.ok(served !== null);
  assert.equal(served.canBuildTx, live,
    "the planted stale verdict was served - canBuildTx is being copied from the cache, not recomputed");
});

test("one refresh in flight at a time - a slow wallet does not get refreshes stacked behind it", async () => {
  // Same argument as the page's own in-flight guard (#699), one layer down: asking a struggling
  // component more often is how a wobble becomes an outage.
  resetNodeStatusCacheForTests();
  const w = wallet({ delayMs: 120 });
  await Promise.all([refreshNodeStatusForTests(), refreshNodeStatusForTests(), refreshNodeStatusForTests()]);
  const calls = w.calls();
  restore();
  assert.equal(calls, 1, `three concurrent refreshes made ${calls} wallet reads`);
});

test("a COLD read waits briefly for the first reading, and the wait is capped, not the wallet's", async () => {
  // crosslink/cache.ts records a CI flake from getting this wrong: the suite boots the server and
  // drives the page immediately, so a first request that races the warm-up renders not-ready
  // against a perfectly healthy double.
  resetNodeStatusCacheForTests();
  wallet({ delayMs: 30 });
  const cold = await nodeStatusForPage(Date.now(), 1_000);
  assert.ok(cold !== null, "a cold read did not wait for the first reading at all");
  resetNodeStatusCacheForTests();
  wallet({ delayMs: 5_000 });
  const t0 = Date.now();
  const slow = await nodeStatusForPage(Date.now(), 60);
  const tookMs = Date.now() - t0;
  restore();
  assert.equal(slow, null, "a cold read against a slow wallet should give up and say nothing");
  assert.ok(tookMs < 400, `the cold wait was ${tookMs}ms - it is waiting on the wallet, not on the cap`);
});


test("a PAGE-purpose cached reading can never satisfy a CLAIM-purpose read", async () => {
  // @SDE-Infra asked for this one above all the others, from the consumer side. The watchdog reads
  // /api/health and /api/ready and never /api/status - so this cache cannot reach a rung TODAY. If
  // it ever leaked onto the claim purpose it would feed three that page: the readiness flap rung
  // (a cached GOOD reading during a live outage makes it go QUIET - a check reporting by silence),
  // the fork detector (a stale reference hash against a live zebra hash pages FORK, parks the miner
  // and wakes the owner), and the step-7 node-stall rung (a cached height that does not advance
  // reads as a stalled node).
  //
  // So: warm the cache at one height, move the wallet to another, and require the claim read to
  // come back with the NEW one. A claim read served from this cache returns the old height.
  resetNodeStatusCacheForTests();
  wallet({ heights: [700_000, 700_000] });
  await refreshNodeStatusForTests();
  assert.equal(cachedNodeStatus()?.nodeHeight, 700_000, "the cache did not warm, so this row measures nothing");
  wallet({ heights: [700_050, 700_050] });
  const claim = await getNodeStatus("claim");
  restore();
  assert.ok(claim !== null, "the claim read returned nothing, so the comparison below is vacuous");
  assert.equal(claim.nodeHeight, 700_050,
    "the claim path was served the page cache's reading - a gate decided on a cached height");
});
