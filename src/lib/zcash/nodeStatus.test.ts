/**
 * The node-status read: how long we wait for our own node before calling its height unknown.
 *
 * A timeout here is not a performance setting, it is a CLAIM about the node - past it the page
 * tells a visitor "our node did not report its height just now, so we are not sending", and
 * refuses the claim. Setting it below what the node actually takes turns a healthy faucet into
 * an intermittently broken one, which is what happened on 2026-09-19.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/* ── the timeout is a claim about the node ────────────────────────────── */

test("the node-status timeout defaults above what production actually takes", async () => {
  // MEASURED ON PROD, 2026-09-19: ten samples of /api/status split either side of 4s - answers at
  // 0.9/0.9/1.4/1.9/1.9/2.4/2.8/3.0s carried a node, and 4.8s and 6.7s carried node: null. The old
  // 4000 sat inside the real spread, so roughly one claim in four was refused with "our node did
  // not report its height just now" while the node was healthy and 100% synced.
  const { nodeStatusTimeoutMs } = await import("./nodeStatus.ts");
  delete process.env.FAUCET_NODE_STATUS_TIMEOUT_MS;
  assert.ok(nodeStatusTimeoutMs() > 6_700,
    `the default must clear the slowest reading we have actually seen; got ${nodeStatusTimeoutMs()}`);
});

test("a broken override cannot disable the status read, which would look like an outage", async () => {
  // THE FLOOR IS THE POINT. A timeout of 0 aborts before the node can answer, so EVERY claim is
  // refused with a sentence about the node - a configuration mistake that presents as a node
  // fault and sends whoever reads it to the wrong machine.
  const { nodeStatusTimeoutMs } = await import("./nodeStatus.ts");
  for (const bad of ["0", "-1", "abc", "", "500"]) {
    process.env.FAUCET_NODE_STATUS_TIMEOUT_MS = bad;
    assert.ok(nodeStatusTimeoutMs() >= 1000, `"${bad}" must not fall below the floor`);
  }
  // And a DELIBERATE value is honoured, so the floor is not just ignoring the variable.
  process.env.FAUCET_NODE_STATUS_TIMEOUT_MS = "15000";
  assert.equal(nodeStatusTimeoutMs(), 15_000);
  delete process.env.FAUCET_NODE_STATUS_TIMEOUT_MS;
});
