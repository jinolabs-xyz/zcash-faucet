import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRefillerKind } from "./select.ts";

test("shielding off is always noop, whatever the sender", () => {
  for (const sender of ["real", "zallet"]) {
    assert.equal(selectRefillerKind({ shieldCoinbase: false, sender }), "noop", `sender=${sender}`);
  }
});

test("zallet with shielding on shields via zallet", () => {
  assert.equal(selectRefillerKind({ shieldCoinbase: true, sender: "zallet" }), "zallet");
});

test("the real (transparent) sender never self-refills", () => {
  // Its change returns to a t-address, so there is no shield step to run.
  assert.equal(selectRefillerKind({ shieldCoinbase: true, sender: "real" }), "noop");
});

test("an unrecognised sender is noop rather than a guess", () => {
  assert.equal(selectRefillerKind({ shieldCoinbase: true, sender: "something-else" }), "noop");
});
