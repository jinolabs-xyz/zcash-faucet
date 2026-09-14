import { test } from "node:test";
import assert from "node:assert/strict";
import { incomeSentence } from "./incomeSentence.ts";

test("mining, blocks accepted, shielding on: the reserve is funded by mining, and the count is shown", () => {
  const s = incomeSentence({ minerActive: true, accepted: 255, shieldCoinbase: true });
  assert.match(s, /mines testnet blocks and shields the coinbase/);
  assert.match(s, /255 blocks accepted/);
  assert.doesNotMatch(s, /by hand|rounds to zero/);
});

test("one block is singular", () => {
  assert.match(incomeSentence({ minerActive: true, accepted: 1, shieldCoinbase: true }), /1 block accepted/);
});

test("blocks accepted but shielding off: says so, and that the balance is topped up by hand", () => {
  const s = incomeSentence({ minerActive: true, accepted: 12, shieldCoinbase: false });
  assert.match(s, /12 blocks accepted/);
  assert.match(s, /not shielding/);
  assert.match(s, /by hand/);
});

test("mining with nothing accepted yet, or not mining at all: by hand, and which of the two it is", () => {
  assert.match(incomeSentence({ minerActive: true, accepted: 0, shieldCoinbase: true }), /has not had a block accepted yet.*by hand/);
  assert.match(incomeSentence({ minerActive: true, accepted: null, shieldCoinbase: true }), /has not had a block accepted yet/);
  assert.match(incomeSentence({ minerActive: false, accepted: 0, shieldCoinbase: true }), /not mining right now.*by hand/);
  // A parked miner with a history of accepted blocks: the history is not income today.
  assert.match(incomeSentence({ minerActive: false, accepted: 255, shieldCoinbase: true }), /not mining right now/);
});
