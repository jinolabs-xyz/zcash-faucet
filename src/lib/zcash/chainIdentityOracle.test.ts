/**
 * The oracle's only real decision is reading a branch id out of a response whose
 * shape we have not verified (#249). Everything else is plumbing over
 * classifyChainIdentity, which chainIdentity.test.ts already covers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { branchIdFromRpc, failureDetail, type RpcEnvelope } from "./chainIdentityOracle.ts";

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


// THE HTTP PATH, DRIVEN. SDE-UI's block on #619, and the finding that outlives it: nothing
// asserted any of these strings, so the one hardcoded over in chainIdentity.test.ts was tied to
// nothing that builds it. Change the template and every row there stays green on a sentence the
// oracle no longer emits. That is L38 aimed at my own PR, so the test now drives the function
// that writes the string rather than restating it.
test("the exact error prod returns becomes the exact detail the sentence carries", () => {
  // Measured on prod 2026-09-16: zallet does not implement the method.
  const real: RpcEnvelope = { error: { code: -32601, message: "Method not found" } };
  assert.equal(failureDetail(real), "zallet: Method not found (-32601)");
});

test("an error with an EMPTY message does not build a blank-bracket detail", () => {
  // `??` substituted only null/undefined, so this built "zallet: " - truthy, and the renderer
  // bracketed it into "(zallet: )". Reachable, not merely constructible.
  assert.equal(failureDetail({ error: { message: "" } }), "zallet: RPC error");
  assert.equal(failureDetail({ error: { message: "   " } }), "zallet: RPC error");
  assert.equal(failureDetail({ error: {} }), "zallet: RPC error");
});

test("a code-less error still names the failure, without a dangling bracket", () => {
  assert.equal(failureDetail({ error: { message: "boom" } }), "zallet: boom");
});

test("answering WITHOUT the field is a different sentence from answering with an error", () => {
  // The two the old code could not tell apart: both returned null.
  const noField = failureDetail({ result: {} });
  const rpcError = failureDetail({ error: { code: -32601, message: "Method not found" } });
  assert.match(noField ?? "", /answered without a consensus branch id/);
  assert.notEqual(noField, rpcError);
});

test("and a good answer has no failure to report", () => {
  assert.equal(failureDetail({ result: { consensus: { chaintip: "37a5165b" } } }), null);
  assert.equal(failureDetail({ result: { consensusBranchId: "37a5165b" } }), null);
});
