import { test } from "node:test";
import assert from "node:assert/strict";
import { saltRejectionReason } from "./saltGuard.ts";

const REAL_SALT = "b1946ac92492d2347c6235b4d2611184e0f4a3a5c9e01f8a2b3c4d5e6f708192";

test("production with pow refuses an empty or whitespace salt", () => {
  for (const salt of ["", "   "]) {
    const r = saltRejectionReason({ salt, production: true, challenge: "pow" });
    assert.match(r ?? "", /RATE_LIMIT_SALT is not set/);
  }
});

test("production with pow refuses every template placeholder", () => {
  const placeholders = [
    "__FILL_ME__", // what deploy.sh writes
    "change-me-to-a-long-random-secret", // deploy/z3/faucet.env.example
    "change-me-to-a-random-secret", // .env.example
    "zcash-faucet-dev-salt-change-me", // privacy.ts dev fallback, if pasted
    "  __FILL_ME__  ", // survives whitespace padding
    "ChAnGe-Me-later", // and case games
  ];
  for (const salt of placeholders) {
    const r = saltRejectionReason({ salt, production: true, challenge: "pow" });
    assert.match(r ?? "", /placeholder/, salt);
  }
});

test("turnstile in production is guarded the same way", () => {
  assert.notEqual(saltRejectionReason({ salt: "__FILL_ME__", production: true, challenge: "turnstile" }), null);
  assert.notEqual(saltRejectionReason({ salt: "", production: true, challenge: "turnstile" }), null);
});

test("challenge=none is not guarded, nothing signs with the salt", () => {
  assert.equal(saltRejectionReason({ salt: "", production: true, challenge: "none" }), null);
  assert.equal(saltRejectionReason({ salt: "__FILL_ME__", production: true, challenge: "none" }), null);
});

test("dev is never blocked, whatever the salt", () => {
  for (const salt of ["", "__FILL_ME__", "change-me-to-a-long-random-secret"]) {
    assert.equal(saltRejectionReason({ salt, production: false, challenge: "pow" }), null);
  }
});

test("a real random salt passes in production with either gate", () => {
  assert.equal(saltRejectionReason({ salt: REAL_SALT, production: true, challenge: "pow" }), null);
  assert.equal(saltRejectionReason({ salt: REAL_SALT, production: true, challenge: "turnstile" }), null);
});

test("the rule itself is about SERVING, and where it runs is asserted elsewhere", () => {
  // This function cannot know when it is called, so the build-versus-boot property
  // is pinned in challengeDefault.test.ts against the real import path. Kept here
  // as a pointer, because the obvious place to look for it is this file.
  assert.equal(saltRejectionReason({ salt: "", production: false, challenge: "pow" }), null);
  assert.match(
    saltRejectionReason({ salt: "", production: true, challenge: "pow" }) ?? "",
    /RATE_LIMIT_SALT is not set/,
  );
});
