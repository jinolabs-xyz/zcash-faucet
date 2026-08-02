/**
 * The wording, and the one thing this table is not allowed to do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { networkFacts, parseNetwork, formatAmount, NETWORKS, DEFAULT_NETWORK } from "./network.ts";

test("cTAZ is marked as a feature net, and TAZ is not marked at all", () => {
  assert.equal(networkFacts("taz").beta, null, "marking the ordinary network would train people to ignore the marker");
  assert.match(networkFacts("ctaz").beta ?? "", /feature net/i);
});

test("the tickers differ in case, because cTAZ is not TAZ", () => {
  assert.equal(networkFacts("taz").ticker, "TAZ");
  assert.equal(networkFacts("ctaz").ticker, "cTAZ");
});

test("A MISSING TXID ON TAZ READS AS A FAULT, not as a property of the chain", () => {
  // The whole reason both networks carry this sentence. If TAZ's had been written to
  // match cTAZ's calm one, a Zallet bug that dropped an id would render as normal.
  const taz = networkFacts("taz").noTxidReason;
  assert.match(taz, /fault on our side/i);
  assert.doesNotMatch(taz, /returns no transaction id|nothing to copy/i, "TAZ must not describe this as expected");

  const ctaz = networkFacts("ctaz").noTxidReason;
  assert.match(ctaz, /no transaction id/i);
  assert.doesNotMatch(ctaz, /fault|error|wrong|bug/i, "on cTAZ this is the contract, not a problem");
});

test("THE TABLE CARRIES NO CLAIM ABOUT WHAT A SEND DID", () => {
  // The entry this file exists to refuse. `hasTxid: false` on cTAZ would be a second
  // source of truth for a fact the route already derives from the sender, free to
  // disagree the day a network is pointed at a sender it was not built for. The
  // receipt reads the RESPONSE. If this ever grows a field like these, the receipt
  // has almost certainly started predicting instead of reading.
  for (const n of NETWORKS) {
    const facts = networkFacts(n) as unknown as Record<string, unknown>;
    for (const forbidden of ["hasTxid", "hasTxids", "explorer", "sender", "returnsTxid"]) {
      assert.equal(facts[forbidden], undefined, `${n}.${forbidden} would be a prediction, and the receipt must read`);
    }
  }
});

test("parseNetwork is strict, so absent and wrong stay different answers", () => {
  assert.equal(parseNetwork("taz"), "taz");
  assert.equal(parseNetwork("ctaz"), "ctaz");
  // Defaulting here is what would collapse the distinction: /api/faucet answers 400
  // for a network we do not serve and taz for a client older than the toggle, and it
  // can only tell those apart because this returns null rather than picking one.
  for (const bad of [undefined, null, "", "TAZ", "mainnet", 1, {}, ["taz"]]) {
    assert.equal(parseNetwork(bad), null, `${JSON.stringify(bad)} must not resolve to a network`);
  }
});

test("the default is TAZ, and it is first in display order", () => {
  assert.equal(DEFAULT_NETWORK, "taz");
  assert.equal(NETWORKS[0], "taz");
});

test("amounts render without trailing-zero noise", () => {
  assert.equal(formatAmount(50_000_000n, "ctaz"), "0.5 cTAZ");
  assert.equal(formatAmount(10_000_000n, "taz"), "0.1 TAZ");
  assert.equal(formatAmount(100_000_000n, "taz"), "1 TAZ");
  assert.equal(formatAmount(0n, "taz"), "0 TAZ");
  // A single zatoshi keeps all eight places, because dropping them would round a
  // real amount to zero and this is the one place that renders what was PAID.
  assert.equal(formatAmount(1n, "ctaz"), "0.00000001 cTAZ");
  assert.equal(formatAmount(150_000_000n, "ctaz"), "1.5 cTAZ");
});
