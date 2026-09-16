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

// WHICH SIDE IS SILENT, and the three cases are distinguished because they have different
// owners and different fixes. Prod reported this state long enough to be committed as a
// fixture and nobody could tell from the reason whether it was our node or the reference.
// It was ours, and establishing that took reading the oracle and then querying the public
// lightwalletd by hand.
test("and it names OUR node when ours is the silent one", () => {
  const v = classifyChainIdentity({ ...ok, ourBranchId: null });
  assert.equal(v.state, "cannot-verify");
  assert.match(v.reason, /our node does not report/);
  // Not the other side, or the sentence sends someone to the wrong system.
  assert.doesNotMatch(v.reason, /independent source does not report/);
});

test("and it names the INDEPENDENT SOURCE when theirs is the silent one", () => {
  const v = classifyChainIdentity({ ...ok, theirBranchId: null });
  assert.equal(v.state, "cannot-verify");
  assert.match(v.reason, /independent source does not report/);
  assert.doesNotMatch(v.reason, /our node does not report/);
});

test("and it says so plainly when BOTH are silent, rather than blaming one", () => {
  const v = classifyChainIdentity({ ...ok, ourBranchId: null, theirBranchId: null });
  assert.equal(v.state, "cannot-verify");
  assert.match(v.reason, /neither our node nor the independent source/);
});

// AND WHY, WHEN WE KNOW IT. The real cause on prod was zallet answering HTTP 200 with
// {"error":{"code":-32601,"message":"Method not found"}} - it does not implement the method at
// all. That arrived as the same null a missing FIELD produces, so the app could say a branch id
// was missing and never say the method does not exist.
test("and it carries the cause of our silence when the oracle knows it", () => {
  const v = classifyChainIdentity({
    ...ok,
    ourBranchId: null,
    ourBranchIdDetail: "zallet: Method not found (-32601)",
  });
  assert.equal(v.state, "cannot-verify");
  assert.match(v.reason, /Method not found/);
  assert.match(v.reason, /our node does not report/);
});

// A DETAIL ABOUT OUR SIDE MUST NOT BE ATTACHED TO THEIRS. The oracle only ever learns why OUR
// lookup failed, so printing it under a null on the other side would blame zallet for a
// lightwalletd outage.
test("and it does not blame our side's cause when THEIRS is the silent one", () => {
  const v = classifyChainIdentity({
    ...ok,
    theirBranchId: null,
    ourBranchIdDetail: "zallet: Method not found (-32601)",
  });
  assert.match(v.reason, /independent source does not report/);
  assert.doesNotMatch(v.reason, /Method not found/);
});

// Absent detail degrades to the plain sentence, never to a worse one.
//
// ASSERTED AS A POSITIVE SHAPE, NOT A DENYLIST, and that is the correction. This read
// `doesNotMatch(/\(\)|undefined|null/)`, which SDE-UI walked straight past: "( )" is a dangling
// bracket one space wide and matches none of the three. A list of spellings you thought of
// cannot be complete. The rule that IS complete: if the sentence has a bracket, the bracket has
// something in it.
//
// " " is in the loop because it is the value that broke the old row, and "zallet: " because it
// is REACHABLE rather than merely constructible - a JSON-RPC error with an empty message and no
// code builds exactly that.
test("and an unknown cause reads clean rather than empty-bracketed", () => {
  for (const d of [undefined, null, "", " ", "   ", "\t"]) {
    const v = classifyChainIdentity({ ...ok, ourBranchId: null, ourBranchIdDetail: d });
    assert.match(v.reason, /our node does not report a consensus branch id, so/, JSON.stringify(d));
    const bracket = v.reason.match(/\(([^)]*)\)/);
    assert.equal(bracket, null, `a blank detail still bracketed: ${JSON.stringify(v.reason)}`);
  }
});

test("and any bracket it DOES print has content in it", () => {
  for (const d of ["zallet: Method not found (-32601)", "zallet unreachable: timeout", "x"]) {
    const v = classifyChainIdentity({ ...ok, ourBranchId: null, ourBranchIdDetail: d });
    const bracket = v.reason.match(/\(([^)]*)/);
    assert.notEqual(bracket, null, `expected a bracket for ${JSON.stringify(d)}`);
    assert.ok((bracket?.[1] ?? "").trim().length > 0, `empty bracket for ${JSON.stringify(d)}`);
  }
});

// THE ANTI-VACUITY PARTNER. Every row above matches a phrase, so a reason that named the
// side and dropped the QUESTION would satisfy all three - "our node does not report" alone
// tells an operator nothing about what is unestablished. This pins the half that survived
// from the original sentence, and it is the half that says why anyone should care.
test("naming the side does not cost the sentence its point", () => {
  for (const f of [
    { ...ok, ourBranchId: null },
    { ...ok, theirBranchId: null },
    { ...ok, ourBranchId: null, theirBranchId: null },
  ]) {
    const v = classifyChainIdentity(f);
    assert.match(v.reason, /consensus branch id/, JSON.stringify(f));
    assert.match(v.reason, /whether we share rules is unestablished/, JSON.stringify(f));
  }
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
