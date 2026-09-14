import { test } from "node:test";
import assert from "node:assert/strict";
import { incomeSentence } from "./incomeSentence.ts";

test("mining, blocks accepted, shielding on and working: the reserve is funded by mining, and the count is qualified", () => {
  const s = incomeSentence({ minerActive: true, accepted: 255, shieldCoinbase: true });
  assert.match(s, /mines testnet blocks and shields what it wins/);
  // Our node's count, said as such: the network drops most of them (review of #538).
  assert.match(s, /its node has accepted 255 blocks from it so far, not all of which stay on the network/);
  assert.doesNotMatch(s, /by hand|rounds to zero|accepted by the network|donation/);
});

test("one block is singular", () => {
  assert.match(incomeSentence({ minerActive: true, accepted: 1, shieldCoinbase: true }), /accepted 1 block from it/);
});

test("a missing count is not zero: no claim about blocks is made either way", () => {
  const s = incomeSentence({ minerActive: true, accepted: null, shieldCoinbase: true });
  assert.match(s, /mines testnet blocks and shields what it wins into its own reserve\.$/);
  assert.doesNotMatch(s, /accepted|has not/);
  const off = incomeSentence({ minerActive: true, accepted: null, shieldCoinbase: false });
  assert.doesNotMatch(off, /accepted/);
  assert.match(off, /not shielding.*by hand/);
});

test("blocks accepted but shielding off: says so, and that the balance is topped up by hand", () => {
  const s = incomeSentence({ minerActive: true, accepted: 12, shieldCoinbase: false });
  assert.match(s, /accepted 12 blocks from it/);
  assert.match(s, /not shielding/);
  assert.match(s, /by hand/);
});

test("shielding on but the harvest step failing: set up to shield, failing, by hand", () => {
  const s = incomeSentence({ minerActive: true, accepted: 255, shieldCoinbase: true, harvestFailing: true });
  assert.match(s, /set up to shield what it wins.*but that step is failing right now.*by hand/);
  assert.doesNotMatch(s, /and shields what it wins into its own reserve \(/);
});

test("mining with nothing accepted yet: by hand, and says the node has accepted nothing", () => {
  assert.match(incomeSentence({ minerActive: true, accepted: 0, shieldCoinbase: true }), /has not accepted a block from it yet.*by hand/);
  assert.match(incomeSentence({ minerActive: true, accepted: 0, shieldCoinbase: false }), /has not accepted a block from it yet.*by hand/);
});

test("a parked miner reads as not mining today, whatever its history and whatever the shielding flag", () => {
  for (const shieldCoinbase of [true, false]) {
    for (const accepted of [0, 255, null]) {
      const s = incomeSentence({ minerActive: false, accepted, shieldCoinbase });
      assert.match(s, /^The faucet is not mining right now, so what it hands out is donated or topped up by hand\.$/, `shield=${shieldCoinbase} accepted=${accepted}`);
    }
  }
});
