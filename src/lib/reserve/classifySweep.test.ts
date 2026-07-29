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

test("an unreported count is its own verdict, not evidence of presence OR emptiness", () => {
  // It must not claim "present-but-unspendable" without a number to justify it,
  // and it must not claim "nothing-visible" either: zallet is a rewrite of
  // zcashd and whether it reports this field is unverified, so folding a missing
  // count into "nothing is there" would restore #172's blindness behind a
  // passing test. SDE-Infra's finding on #174.
  assert.equal(classifySweep({ moved: false }), "count-not-reported");
  assert.equal(classifySweep({ moved: false, remainingUTXOs: undefined }), "count-not-reported");
});

test("a REPORTED zero is a fact and stays distinct from a missing count", () => {
  assert.equal(classifySweep({ moved: false, remainingUTXOs: 0 }), "nothing-visible");
  assert.notEqual(
    classifySweep({ moved: false, remainingUTXOs: 0 }),
    classifySweep({ moved: false }),
  );
});
