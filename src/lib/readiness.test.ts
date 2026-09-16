import { test } from "node:test";
import assert from "node:assert/strict";
import { readinessReason, type ReadinessInputs } from "./readiness.ts";

const healthy: ReadinessInputs = {
  ledgerBlocks: false,
  backendReachable: true,
  node: { ready: true, frozen: false, shield: { state: "safe", lag: 1 } },
  balanceZat: 100_000_000n,
  sendsBlock: false,
  sendsReason: null,
  floorZat: 50_000_000n,
  nodeExpected: true,
};

test("a healthy faucet has no reason", () => {
  assert.equal(readinessReason(healthy), null);
});

test("UNSAFE: our node measurably behind the network is not ready, and the reason carries the lag", () => {
  const r = readinessReason({ ...healthy, node: { ready: true, frozen: false, shield: { state: "unsafe", lag: 40 } } });
  assert.equal(r, "node 40 blocks behind the network, drips would expire");
});

test("UNVERIFIABLE: a tip we cannot verify keeps the faucet READY, so an oracle outage cannot roll back a deploy", () => {
  // THE asymmetry. A `!== "safe"` here would let hosh.zec.rocks being down page as a
  // node fault and hand redeploy a reason to revert a good build. The refusal is still
  // visible: the route puts node.canBuildTx:false in the body for the pagers.
  const r = readinessReason({ ...healthy, node: { ready: true, frozen: false, shield: { state: "unverifiable", lag: null } } });
  assert.equal(r, null);
});

test("the send gate sits below the node's own state and above the wallet", () => {
  const behind = { ready: true, frozen: false, shield: { state: "unsafe" as const, lag: 40 } };
  assert.equal(readinessReason({ ...healthy, node: { ...behind, frozen: true } }), "node frozen behind network");
  assert.equal(readinessReason({ ...healthy, node: { ...behind, ready: false } }), "wallet re-scanning, behind our node");
  assert.equal(readinessReason({ ...healthy, node: behind, balanceZat: null }), "node 40 blocks behind the network, drips would expire");
  assert.equal(readinessReason({ ...healthy, node: behind, sendsBlock: true, sendsReason: "every send timed out" }), "node 40 blocks behind the network, drips would expire");
});

test("a lagging wallet is named as the wallet, with the distance, not as the node", () => {
  // THE PRODUCTION EPISODE, as inputs (#596). At 02:32:48 the wallet had scanned 4353366 while
  // our node was at 4353416: ready:false, frozen:false, and zebra perfectly healthy at the tip.
  // The old rung said "node syncing" and sent the operator to the machine that was fine.
  const rescanning = {
    ready: false, frozen: false, height: 4_353_366, nodeHeight: 4_353_416,
    shield: { state: "unverifiable" as const, lag: null },
  };
  assert.equal(readinessReason({ ...healthy, node: rescanning }),
    "wallet re-scanning, 50 blocks behind our node");

  // THE WORD "node" MUST NOT APPEAR AS THE SUBJECT. Asserting the whole string is what pins
  // that; a test for /wallet/ alone would pass a message that named both and still misdirected.
  const r = readinessReason({ ...healthy, node: rescanning }) ?? "";
  assert.ok(r.startsWith("wallet "), r);
});

test("the wallet rung is unreachable for a frozen node, so it can never be about the node", () => {
  // `ready` is `walletCaughtUp && !frozen`, and `frozen` is caught by the rung ABOVE. So a
  // node that is frozen AND has a lagging wallet reports frozen, and the only way to reach the
  // wallet rung is with frozen already false - which leaves `walletCaughtUp` as the sole false
  // term. This is the test that makes "it is never the node here" a property rather than a
  // paragraph in a comment.
  const both = { ready: false, frozen: true, height: 10, nodeHeight: 999,
                 shield: { state: "unverifiable" as const, lag: null } };
  assert.equal(readinessReason({ ...healthy, node: both }), "node frozen behind network");
});

test("an unreadable height still names the wallet rather than inventing a distance", () => {
  // getNodeStatus() gives height and nodeHeight as number|null, so "how far behind" is not
  // always answerable. The machine is, and that is the half the operator acts on.
  const noHeights = { ready: false, frozen: false, height: null, nodeHeight: null,
                      shield: { state: "unverifiable" as const, lag: null } };
  assert.equal(readinessReason({ ...healthy, node: noHeights }), "wallet re-scanning, behind our node");
});

test("the order of the rest is unchanged: ledger, backend, node, wallet, sends, reserve", () => {
  assert.equal(readinessReason({ ...healthy, ledgerBlocks: true, backendReachable: false }), "ledger unreadable");
  assert.equal(readinessReason({ ...healthy, backendReachable: false, balanceZat: null }), "backend unreachable");
  assert.equal(readinessReason({ ...healthy, balanceZat: null, sendsBlock: true }), "wallet balance unknown");
  assert.equal(readinessReason({ ...healthy, sendsBlock: true, sendsReason: "3 of 3 failed", balanceZat: 1n }), "sends failing: 3 of 3 failed");
  assert.equal(readinessReason({ ...healthy, balanceZat: 49_999_999n }), "below reserve, refilling");
  assert.equal(readinessReason({ ...healthy, balanceZat: 50_000_000n }), null, "at the floor is not below it");
});

test("no node to ask (sender is not zallet) skips every node check", () => {
  assert.equal(readinessReason({ ...healthy, node: null, nodeExpected: false }), null);
});

test("a node that IS expected and did not answer is NOT ready: the gate cannot be verified and the pagers would see nothing", () => {
  // The claim path refuses in this state (chainFreshness(null, ...) is unverifiable). A 200
  // with no node block hid that from every reader of node.canBuildTx.
  assert.equal(readinessReason({ ...healthy, node: null, nodeExpected: true }), "node status unknown");
  // Upstream of the wallet checks, downstream of the ledger and the backend.
  assert.equal(readinessReason({ ...healthy, node: null, nodeExpected: true, balanceZat: null }), "node status unknown");
  assert.equal(readinessReason({ ...healthy, node: null, nodeExpected: true, backendReachable: false }), "backend unreachable");
});
