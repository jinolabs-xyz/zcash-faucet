/**
 * The oracle's only real decision is reading a branch id out of a response whose
 * shape we have not verified (#249). Everything else is plumbing over
 * classifyChainIdentity, which chainIdentity.test.ts already covers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { branchIdFromRpc } from "./chainIdentityOracle.ts";

test("reads zebra's shape, where the branch id is nested under consensus", () => {
  assert.equal(branchIdFromRpc({ result: { consensus: { chaintip: "37a5165b" } } }), "37a5165b");
});

test("reads the flat zcashd-style shape too, since we have not verified which zallet gives", () => {
  assert.equal(branchIdFromRpc({ result: { consensusBranchId: "37a5165b" } }), "37a5165b");
});

test("prefers the nested one when a response somehow carries both", () => {
  // Not expected, but a silent pick between two disagreeing values is worth pinning
  // rather than leaving to whichever ?? lands first after an edit.
  assert.equal(
    branchIdFromRpc({ result: { consensus: { chaintip: "aaaa" }, consensusBranchId: "bbbb" } }),
    "aaaa",
  );
});

test("an unsupported method yields null, which is cannot-verify and NOT a mismatch", () => {
  // The distinction the whole check rests on: a node that will not answer is not a
  // node on a different chain.
  assert.equal(branchIdFromRpc({}), null);
  assert.equal(branchIdFromRpc({ result: {} }), null);
});
