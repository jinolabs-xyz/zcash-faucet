import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyChainIdentity,
  comparisonHeight,
  isChainProblem,
  COMPARE_DEPTH_BLOCKS,
  type IdentityFacts,
} from "./chainIdentity.ts";

/** Real values: 37a5165b is testnet NU6.3, and the hash is cipherscan's for height 4223000. */
const BRANCH = "37a5165b";
const HASH = "000c424faf2bc5d7c6ff10125c7d973956b4c80185893f66236143adbf3c35ab";
const ok: IdentityFacts = {
  ourBranchId: BRANCH,
  theirBranchId: BRANCH,
  comparedAtHeight: 4_223_000,
  ourHashAtHeight: HASH,
  theirHashAtHeight: HASH,
};

test("same rules and same history is the only clean answer", () => {
  const v = classifyChainIdentity(ok);
  assert.equal(v.state, "same-chain");
  assert.equal(isChainProblem(v), false);
});

test("a hash mismatch under matching rules is a FORK", () => {
  const v = classifyChainIdentity({ ...ok, theirHashAtHeight: "00" + "ff".repeat(31) });
  assert.equal(v.state, "forked");
  assert.equal(isChainProblem(v), true);
  assert.match(v.reason, /chain split/);
});

test("hex case is not a fork", () => {
  // Sources disagree on case routinely. Reporting that as a split would page a human
  // about a string comparison.
  const v = classifyChainIdentity({ ...ok, theirHashAtHeight: HASH.toUpperCase() });
  assert.equal(v.state, "same-chain");
});

test("different rules is reported as different rules, NOT as a fork", () => {
  // Checked first on purpose: different rules explain a hash mismatch, and the reverse
  // is not true. Calling it a fork sends someone hunting a split that does not exist.
  const v = classifyChainIdentity({
    ...ok,
    theirBranchId: "c2d6d0b4",
    theirHashAtHeight: "00" + "ff".repeat(31),
  });
  assert.equal(v.state, "different-rules");
  assert.equal(isChainProblem(v), true);
  assert.match(v.reason, /network\s+upgrade/);
  assert.doesNotMatch(v.reason, /chain split/);
});

test("a missing branch id is cannot-verify, not agreement", () => {
  const v = classifyChainIdentity({ ...ok, theirBranchId: null });
  assert.equal(v.state, "cannot-verify");
  assert.equal(isChainProblem(v), false);
});

test("a missing hash is cannot-verify, and says rules still matched", () => {
  // The partial result is worth keeping: rules agreeing is real information even when
  // history could not be checked.
  const v = classifyChainIdentity({ ...ok, theirHashAtHeight: null });
  assert.equal(v.state, "cannot-verify");
  assert.match(v.reason, /Rules match/);
  assert.equal(isChainProblem(v), false);
});

test("no common height is cannot-verify", () => {
  const v = classifyChainIdentity({ ...ok, comparedAtHeight: null });
  assert.equal(v.state, "cannot-verify");
  assert.equal(isChainProblem(v), false);
});

test("cannot-verify NEVER counts as a chain problem, across every shape", () => {
  // An unreachable explorer is not a fork. Every source we have is intermittent, so
  // this is the mapping that decides whether the check is usable at all.
  const shapes: IdentityFacts[] = [
    { ...ok, ourBranchId: null },
    { ...ok, theirBranchId: null },
    { ...ok, comparedAtHeight: null },
    { ...ok, ourHashAtHeight: null },
    { ...ok, theirHashAtHeight: null },
  ];
  for (const s of shapes) {
    const v = classifyChainIdentity(s);
    assert.equal(v.state, "cannot-verify", JSON.stringify(s));
    assert.equal(isChainProblem(v), false);
  }
});

test("the compared height is below BOTH tips, so we never ask for a block they lack", () => {
  // Using our own tip would ask them about a block they may not have yet and read the
  // absence as a fork. That is the false positive this rule exists to prevent.
  assert.equal(comparisonHeight(4_223_100, 4_223_000), 4_223_000 - COMPARE_DEPTH_BLOCKS);
  assert.equal(comparisonHeight(4_223_000, 4_223_100), 4_223_000 - COMPARE_DEPTH_BLOCKS);
});

test("comparing at the tip is refused, because tips disagree innocently", () => {
  // Depth is not decoration: two nodes seconds apart have different tips and one is
  // about to be reorged. A depth of 0 would report a fork most times it ran.
  assert.ok(COMPARE_DEPTH_BLOCKS > 0);
  assert.equal(comparisonHeight(10, 10), null, "a chain shorter than the depth has no honest common height");
});

test("an unknown tip on either side yields no comparison height", () => {
  assert.equal(comparisonHeight(null, 4_223_000), null);
  assert.equal(comparisonHeight(4_223_000, null), null);
});
