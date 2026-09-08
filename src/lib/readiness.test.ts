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
  assert.equal(readinessReason({ ...healthy, node: { ...behind, ready: false } }), "node syncing");
  assert.equal(readinessReason({ ...healthy, node: behind, balanceZat: null }), "node 40 blocks behind the network, drips would expire");
  assert.equal(readinessReason({ ...healthy, node: behind, sendsBlock: true, sendsReason: "every send timed out" }), "node 40 blocks behind the network, drips would expire");
});

test("the order of the rest is unchanged: ledger, backend, node, wallet, sends, reserve", () => {
  assert.equal(readinessReason({ ...healthy, ledgerBlocks: true, backendReachable: false }), "ledger unreadable");
  assert.equal(readinessReason({ ...healthy, backendReachable: false, balanceZat: null }), "backend unreachable");
  assert.equal(readinessReason({ ...healthy, balanceZat: null, sendsBlock: true }), "wallet balance unknown");
  assert.equal(readinessReason({ ...healthy, sendsBlock: true, sendsReason: "3 of 3 failed", balanceZat: 1n }), "sends failing: 3 of 3 failed");
  assert.equal(readinessReason({ ...healthy, balanceZat: 49_999_999n }), "below reserve, refilling");
  assert.equal(readinessReason({ ...healthy, balanceZat: 50_000_000n }), null, "at the floor is not below it");
});

test("no node verdict at all (sender is not zallet, or the node did not answer) skips every node check", () => {
  assert.equal(readinessReason({ ...healthy, node: null }), null);
});
