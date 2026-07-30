/**
 * The case that matters is tx 29, reproduced from its real numbers. The rest are the
 * ways this alarm could fire when it should not, which is what would get it turned off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPayout, shouldAlarm, type PayoutFacts } from "./payoutDead.ts";

/** A payout that is fine: known, unmined, plenty of headroom. */
const base: PayoutFacts = { knownByWallet: true, confirmations: 0, expiryHeight: 4_221_140, tip: 4_221_100 };

test("tx 29: created after its expiry was already mined, and that is the alarm", () => {
  // The real failure. Its expiry height had been mined four seconds before the
  // transaction existed, so no miner could ever include it, and nothing noticed for
  // seven hours.
  const v = classifyPayout({ knownByWallet: true, confirmations: 0, expiryHeight: 4_209_400, tip: 4_209_427 });
  assert.equal(v.fate, "dead");
  assert.equal(shouldAlarm(v), true);
  assert.match(v.reason, /can never be mined/);
});

test("a mined payout is mined even if the numbers look expired", () => {
  // Inclusion beats arithmetic: if it is in a block it was included before expiry, and
  // a tip past the expiry means one of those numbers is stale, not the block.
  const v = classifyPayout({ knownByWallet: true, confirmations: 3, expiryHeight: 100, tip: 999_999 });
  assert.equal(v.fate, "mined");
  assert.equal(shouldAlarm(v), false);
});

test("a fresh unmined send with headroom is pending, not an alarm", () => {
  const v = classifyPayout(base);
  assert.equal(v.fate, "pending");
  assert.equal(shouldAlarm(v), false);
  assert.match(v.reason, /40 block\(s\) of expiry headroom/);
});

test("tip EQUAL to the expiry is ALREADY dead, because that block is mined without it", () => {
  // This test previously asserted "pending" and enshrined an off-by-one. A tx with
  // expiryheight H is valid only at heights <= H, so when the tip IS H the block at H
  // exists and does not contain it, and the next block is H+1 where it is invalid.
  //
  // Worth keeping the correction visible: my sabotage check "passed" against the wrong
  // boundary, because I wrote the code and the test from the same premise. Sabotage
  // proves a test can detect a change; it cannot prove the boundary matches consensus.
  const v = classifyPayout({ ...base, expiryHeight: 4_221_100, tip: 4_221_100 });
  assert.equal(v.fate, "dead");
  assert.equal(shouldAlarm(v), true);
});

test("one block BELOW the expiry is still pending, so the boundary is exact both ways", () => {
  // The real control. At tip H-1 the block at H has not been mined yet, so inclusion is
  // still possible. Without this, moving every case to "dead" would pass the test above.
  const v = classifyPayout({ ...base, expiryHeight: 4_221_100, tip: 4_221_099 });
  assert.equal(v.fate, "pending");
  assert.equal(shouldAlarm(v), false);
  assert.match(v.reason, /1 block\(s\) of expiry headroom/);
});

test("expiry height 0 means NEVER expires, not expired long ago", () => {
  // Treating 0 as a threshold declares every such payout dead the moment the chain
  // moves, which is the loudest possible false alarm.
  const v = classifyPayout({ ...base, expiryHeight: 0, tip: 9_999_999 });
  assert.equal(v.fate, "pending");
  assert.equal(shouldAlarm(v), false);
  assert.match(v.reason, /never expires/);
});

test("a wallet that could not answer is cannot-tell, never pending", () => {
  // A wallet that is down produces the same silence as a wallet with nothing to
  // report. Rounding that to "pending" is how a seven-hour outage reads as normal.
  const v = classifyPayout({ ...base, knownByWallet: null, confirmations: null });
  assert.equal(v.fate, "cannot-tell");
  assert.equal(shouldAlarm(v), false);
});

test("a wallet that has never seen the tx does NOT borrow the expiry alarm's certainty", () => {
  // A send that failed before broadcast looks like this, and so does a restored wallet
  // that lost its view. Both are worth investigating and neither is proven dead.
  const v = classifyPayout({ ...base, knownByWallet: false, confirmations: null });
  assert.equal(v.fate, "cannot-tell");
  assert.equal(shouldAlarm(v), false);
  assert.match(v.reason, /no record of this transaction/);
});

test("an unknown tip cannot be compared, so it is cannot-tell not dead", () => {
  // The fail-closed direction for an alarm is QUIET: a node that cannot report its
  // tip must not be able to declare every outstanding payout dead.
  const v = classifyPayout({ ...base, tip: null });
  assert.equal(v.fate, "cannot-tell");
  assert.equal(shouldAlarm(v), false);
});

test("a missing expiry height is cannot-tell", () => {
  const v = classifyPayout({ ...base, expiryHeight: null });
  assert.equal(v.fate, "cannot-tell");
  assert.equal(shouldAlarm(v), false);
});

test("only 'dead' alarms, across every state", () => {
  // Pins the whole mapping in one place, so adding a fate cannot silently become
  // alarming or silently become ignorable.
  const fates = [
    classifyPayout({ knownByWallet: true, confirmations: 2, expiryHeight: 10, tip: 5 }),
    classifyPayout(base),
    classifyPayout({ ...base, tip: null }),
    classifyPayout({ ...base, expiryHeight: 4_221_000, tip: 4_221_100 }),
  ];
  assert.deepEqual(
    fates.map((v) => [v.fate, shouldAlarm(v)]),
    [
      ["mined", false],
      ["pending", false],
      ["cannot-tell", false],
      ["dead", true],
    ],
  );
});
