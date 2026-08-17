import { test } from "node:test";
import assert from "node:assert/strict";
import {
  walletLagFreshness,
  mayBuildFromWallet,
  WALLET_MAX_LAG_BLOCKS,
  WALLET_LAG_CEILING,
  EXPIRY_DELTA_BLOCKS,
} from "./walletLagGate.ts";

// The decision is a pure function of two heights, so the branches that only happen
// mid-outage are reachable here without a network or a mocked wallet.

test("caught up is safe", () => {
  const g = walletLagFreshness(4_279_780, 4_279_780);
  assert.equal(g.state, "safe");
  assert.equal(g.lag, 0);
  assert.equal(mayBuildFromWallet(g), true);
});

test("a wallet ahead of the node is safe, not suspect", () => {
  // Happens transiently while the node is mid-write. It cannot stale an expiry.
  const g = walletLagFreshness(4_279_782, 4_279_780);
  assert.equal(g.state, "safe");
  assert.equal(g.lag, -2);
  assert.equal(mayBuildFromWallet(g), true);
});

test("a small lag inside the budget is safe", () => {
  const g = walletLagFreshness(4_279_780 - (WALLET_MAX_LAG_BLOCKS - 1), 4_279_780);
  assert.equal(g.state, "safe");
  assert.equal(mayBuildFromWallet(g), true);
});

test("one block past the budget refuses", () => {
  const g = walletLagFreshness(4_279_780 - (WALLET_MAX_LAG_BLOCKS + 1), 4_279_780);
  assert.equal(g.state, "unsafe");
  assert.equal(mayBuildFromWallet(g), false);
});

test("THE 2026-08-17 INCIDENT: the exact heights that produced a born-expired drip", () => {
  // From the zebra rejection and /api/ready in the same minute:
  //   wallet 4,279,669 +40 -> expiry 4,279,710, node tip 4,279,780.
  //   RPC -25: must not be mined at Height(4279780) greater than its expiry Height(4279710)
  // shieldGate said "safe" here and was right on its own terms - the node was fresh.
  // This gate is the one that had to say no.
  const g = walletLagFreshness(4_279_669, 4_279_780);
  assert.equal(g.state, "unsafe");
  assert.equal(g.lag, 111);
  assert.equal(mayBuildFromWallet(g), false);
  // The reason must carry the arithmetic, so an operator reading a log line sees why
  // rather than just that something was refused.
  assert.match(g.reason, /4279709|4,?279,?709/);
  assert.match(g.reason, /never be mined/);
});

test("a lag at or past the expiry delta says it could never be mined", () => {
  const g = walletLagFreshness(4_279_780 - EXPIRY_DELTA_BLOCKS, 4_279_780);
  assert.equal(g.state, "unsafe");
  assert.match(g.reason, /never be mined/);
});

test("a lag over budget but under the delta warns about being overtaken, not certain death", () => {
  const lag = WALLET_MAX_LAG_BLOCKS + 1;
  assert.ok(lag < EXPIRY_DELTA_BLOCKS, "fixture must sit between the budget and the cliff");
  const g = walletLagFreshness(4_279_780 - lag, 4_279_780);
  assert.equal(g.state, "unsafe");
  assert.match(g.reason, /overtaken/);
});

test("an unreadable wallet height refuses rather than assuming", () => {
  const g = walletLagFreshness(null, 4_279_780);
  assert.equal(g.state, "unverifiable");
  assert.equal(g.lag, null);
  assert.equal(mayBuildFromWallet(g), false);
  assert.match(g.reason, /wallet/);
});

test("an unreadable node tip refuses rather than assuming", () => {
  const g = walletLagFreshness(4_279_780, null);
  assert.equal(g.state, "unverifiable");
  assert.equal(mayBuildFromWallet(g), false);
  assert.match(g.reason, /node/);
});

test("both unreadable refuses", () => {
  assert.equal(mayBuildFromWallet(walletLagFreshness(null, null)), false);
});

test("the budget stays under the cliff, so a permitted lag can never guarantee death", () => {
  // The whole thesis: a lag we call safe must leave the expiry ahead of the tip.
  assert.ok(WALLET_MAX_LAG_BLOCKS < EXPIRY_DELTA_BLOCKS);
  assert.ok(WALLET_LAG_CEILING < EXPIRY_DELTA_BLOCKS);
  assert.ok(WALLET_MAX_LAG_BLOCKS <= WALLET_LAG_CEILING);
});
