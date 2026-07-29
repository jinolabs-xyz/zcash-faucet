import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySweep } from "./decide.ts";

test("funds moving is reported as moved, whatever remains", () => {
  assert.equal(classifySweep({ moved: true }), "moved");
  assert.equal(classifySweep({ moved: true, remainingUTXOs: 0 }), "moved");
  assert.equal(classifySweep({ moved: true, remainingUTXOs: 9 }), "moved");
});

test("nothing moved and nothing left over is an honestly empty sweep", () => {
  assert.equal(classifySweep({ moved: false, remainingUTXOs: 0 }), "nothing-visible");
});

test("nothing moved while UTXOs REMAIN is the 47.5 TAZ shape, not an empty sweep", () => {
  // The whole point of #172: this used to be byte-identical to a quiet tick.
  assert.equal(classifySweep({ moved: false, remainingUTXOs: 3 }), "present-but-unspendable");
  assert.equal(classifySweep({ moved: false, remainingUTXOs: 48 }), "present-but-unspendable");
});

test("an unreported count is not evidence of presence OR emptiness", () => {
  // It must not claim "present-but-unspendable" without a number to justify it,
  // which would be inventing a verdict the backend never gave us.
  assert.equal(classifySweep({ moved: false }), "nothing-visible");
  assert.equal(classifySweep({ moved: false, remainingUTXOs: undefined }), "nothing-visible");
});
