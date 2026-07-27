import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRefillerKind } from "./select.ts";

test("miner off is always noop, whatever else is set", () => {
  for (const sender of ["mock", "real", "zallet"]) {
    for (const mockRefill of [true, false]) {
      assert.equal(
        selectRefillerKind({ minerActive: false, sender, mockRefill }),
        "noop",
        `sender=${sender} mockRefill=${mockRefill}`,
      );
    }
  }
});

test("zallet sender with the miner on shields via zallet", () => {
  assert.equal(selectRefillerKind({ minerActive: true, sender: "zallet", mockRefill: false }), "zallet");
  // The mock opt-in is irrelevant to the zallet path.
  assert.equal(selectRefillerKind({ minerActive: true, sender: "zallet", mockRefill: true }), "zallet");
});

test("mock refill needs BOTH the miner flag and the explicit opt-in", () => {
  assert.equal(selectRefillerKind({ minerActive: true, sender: "mock", mockRefill: true }), "mock");
  assert.equal(selectRefillerKind({ minerActive: true, sender: "mock", mockRefill: false }), "noop");
});

test("the real (transparent) sender never self-refills", () => {
  assert.equal(selectRefillerKind({ minerActive: true, sender: "real", mockRefill: false }), "noop");
  assert.equal(selectRefillerKind({ minerActive: true, sender: "real", mockRefill: true }), "noop");
});
