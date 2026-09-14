import { test } from "node:test";
import assert from "node:assert/strict";
import { opsTokenMatches } from "./opsToken.ts";

const TOKEN = "e5a0c9d1b3f74268a1f0c2d4e6b8a0c2";

test("the configured token, presented exactly, is the only yes", () => {
  assert.equal(opsTokenMatches(TOKEN, TOKEN), true);
  assert.equal(opsTokenMatches(TOKEN.slice(0, -1) + "x", TOKEN), false);
  assert.equal(opsTokenMatches(TOKEN + "0", TOKEN), false, "a longer string is not a prefix match");
  assert.equal(opsTokenMatches(TOKEN.slice(0, -1), TOKEN), false);
});

test("no token configured, or a short one, refuses everyone: the safe default is one word for all", () => {
  assert.equal(opsTokenMatches(TOKEN, undefined), false);
  assert.equal(opsTokenMatches("", ""), false, "empty must not equal empty");
  assert.equal(opsTokenMatches("short", "short"), false, "a token under 16 chars is a placeholder, not a secret");
  assert.equal(opsTokenMatches(null, TOKEN), false);
});

test("whitespace around the configured value is not part of it: a trailing space in faucet.env still matches", () => {
  assert.equal(opsTokenMatches(TOKEN, `${TOKEN} `), true);
  assert.equal(opsTokenMatches(TOKEN, `${TOKEN}\n`), true);
  assert.equal(opsTokenMatches(` ${TOKEN}`, TOKEN), true);
});
