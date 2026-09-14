import { test } from "node:test";
import assert from "node:assert/strict";
import { powEstimateSeconds, powEstimateText, POW_MIN_SAMPLE } from "./powEstimate.ts";

test("no estimate before the worker has reported a sample: a rate from ten hashes is noise", () => {
  assert.equal(powEstimateSeconds({ difficulty: 20, hashes: 10, ms: 5 }), null);
  assert.equal(powEstimateSeconds({ difficulty: 20, hashes: POW_MIN_SAMPLE, ms: 0 }), null);
  assert.equal(powEstimateText(null), "measuring");
});

test("the estimate is 2^difficulty at the measured rate, not the remaining count", () => {
  // 8192 hashes in 8 ms is 1024 hashes/ms; 2^20 of them take 1024 ms.
  assert.equal(powEstimateSeconds({ difficulty: 20, hashes: 8192, ms: 8 }), 1.024);
  // Having done more hashes at the same rate changes nothing: a lottery has no progress.
  assert.equal(powEstimateSeconds({ difficulty: 20, hashes: 819200, ms: 800 }), 1.024);
  // Two more bits is four times as long.
  assert.equal(powEstimateSeconds({ difficulty: 22, hashes: 8192, ms: 8 }), 4.096);
});

test("the text is coarse: whole seconds under ten, fives under a minute, minutes above", () => {
  assert.equal(powEstimateText(0.4), "under a second");
  assert.equal(powEstimateText(3.4), "about 3 s");
  assert.equal(powEstimateText(23), "about 25 s");
  assert.equal(powEstimateText(47), "about 45 s");
  // 25 bits on a phone, the register's ~5 min case.
  assert.equal(powEstimateText(290), "about 5 min");
  assert.equal(powEstimateText(61), "about 1 min");
  assert.equal(powEstimateText(58), "about 1 min", "never 'about 60 s'");
  assert.equal(powEstimateText(57), "about 55 s");
});
