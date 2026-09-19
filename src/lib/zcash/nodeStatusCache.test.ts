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

test("a COLD read returns the reading rather than giving up on it - the fail-closed property", async () => {
  // THIS ROW EXISTS BECAUSE I SHIPPED THE OPPOSITE AND api-integration CAUGHT IT. The first version
  // capped the cold wait at 3s. getNodeStatus returns a COMPLETE NodeStatus with canBuildTx:false
  // when the tip oracle cannot answer - "cannot verify, so the gate is closed" - and giving up on
  // that read produces node:null, where canBuildTx is not false but UNDEFINED. Three rows in
  // api-integration failed on exactly that, including "canBuildTx is false on cannot-verify, not
  // just on too-far-behind (canBuildTx undefined)". The money gate's fail-closed property had
  // become an absent field.
  //
  // The cold wait is bounded by the read's own page budget - one 4s attempt - so awaiting it fully
  // is what the route did before this module existed, and is paid once per process.
  resetNodeStatusCacheForTests();
  wallet({ delayMs: 120, heights: [800_000, 800_000] });
  const t0 = Date.now();
  const cold = await nodeStatusForPage();
  const tookMs = Date.now() - t0;
  restore();
  assert.ok(cold !== null, "a cold read gave up and returned null - the verdict is now undefined rather than false");
  assert.equal(cold.nodeHeight, 800_000);
  assert.ok(typeof cold.canBuildTx === "boolean", "canBuildTx must be a boolean, never absent");
  assert.ok(tookMs >= 100, `the cold read did not actually wait (${tookMs}ms) - it cannot have read anything`);
});

test("a WARM read still does not wait, so the cold-path fix did not put the latency back", async () => {
  // The pair to the row above: making the COLD path await in full must not make the WARM path do
  // it too, or the fix for the verdict would have undone the reason this module exists.
  resetNodeStatusCacheForTests();
  wallet({ delayMs: 0 });
  await refreshNodeStatusForTests();
  wallet({ delayMs: 400 });
  const t0 = Date.now();
  await nodeStatusForPage(Date.now() + 5_000);
  const tookMs = Date.now() - t0;
  restore();
  assert.ok(tookMs < 150, `a warm read waited ${tookMs}ms on a 400ms wallet`);
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


test("a STALE cache waits too, not just a cold one - the bug my first fix missed", async () => {
  // api-integration caught this and a cold-cache reproduction could not: the suite reaches its
  // cannot-verify assertion minutes after the entry was written, so the cache is STALE rather than
  // COLD. My first fix awaited only when `at === 0`, so an entry past the window returned null
  // without waiting - and node:null makes canBuildTx UNDEFINED rather than FALSE, which is the
  // money gate's fail-closed verdict going missing.
  //
  // STALENESS IS SIMULATED BY BACKDATING THE ENTRY, not by passing a future clock. My first
  // version of this row did the latter, and then the reading written DURING the await was itself
  // "old" relative to that future instant, so the row failed against correct code. Production
  // staleness is an old entry against a real clock; that is what this reproduces.
  resetNodeStatusCacheForTests();
  wallet({ heights: [600_000, 600_000] });
  await refreshNodeStatusForTests();
  const cell = (globalThis as unknown as { __nodeStatusCache?: { at: number } }).__nodeStatusCache;
  assert.ok(cell && cell.at > 0, "nothing was cached, so this row would measure nothing");
  cell.at = Date.now() - NODE_STATUS_MAX_AGE_MS * 4; // an entry far past the window
  assert.equal(cachedNodeStatus(), null, "the backdated entry is still serveable - the setup did not take");
  wallet({ delayMs: 60, heights: [600_100, 600_100] });
  const served = await nodeStatusForPage();
  restore();
  assert.ok(served !== null, "a stale cache returned null instead of waiting - canBuildTx is undefined, not false");
  assert.ok(typeof served.canBuildTx === "boolean", "canBuildTx must be a boolean, never absent");
  assert.equal(served.nodeHeight, 600_100, "it served something other than the read it just waited for");
});


test("the boundary: one millisecond past MAX_AGE still waits", async () => {
  // @SDE-App asked for exactly this age, because a mutant restoring `c.at === 0` is INVISIBLE to
  // every row that starts from a cold cell - the cold case waits under either condition. Only an
  // entry that exists and is just past the window separates them.
  resetNodeStatusCacheForTests();
  wallet({ heights: [500_000, 500_000] });
  await refreshNodeStatusForTests();
  const cell = (globalThis as unknown as { __nodeStatusCache?: { at: number } }).__nodeStatusCache;
  assert.ok(cell && cell.at > 0, "nothing cached, so this row would measure nothing");
  cell.at = Date.now() - (NODE_STATUS_MAX_AGE_MS + 1);
  wallet({ delayMs: 40, heights: [500_001, 500_001] });
  const served = await nodeStatusForPage();
  restore();
  assert.ok(served !== null, "one millisecond past the window returned null without waiting");
  assert.equal(served.nodeHeight, 500_001);
});

test("and one millisecond INSIDE the window does NOT wait, so the fix did not make every read block", () => {
  // The pair. Without this, "wait whenever in doubt" would pass the row above and quietly put the
  // wallet's latency back on every request, which is the defect the module exists to remove.
  resetNodeStatusCacheForTests();
  wallet({ heights: [500_000, 500_000] });
  return refreshNodeStatusForTests().then(async () => {
    const cell = (globalThis as unknown as { __nodeStatusCache?: { at: number } }).__nodeStatusCache;
    cell!.at = Date.now() - (NODE_STATUS_MAX_AGE_MS - 1);
    wallet({ delayMs: 500, heights: [500_002, 500_002] });
    const t0 = Date.now();
    const served = await nodeStatusForPage();
    const tookMs = Date.now() - t0;
    restore();
    assert.ok(served !== null, "a serveable entry returned nothing");
    assert.equal(served.nodeHeight, 500_000, "it waited for the new read instead of serving what it had");
    assert.ok(tookMs < 150, `a serveable entry waited ${tookMs}ms on a 500ms wallet`);
  });
});
