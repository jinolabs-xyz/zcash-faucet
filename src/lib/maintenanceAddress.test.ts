/**
 * The only address in this app that handles real money, so it gets tested in
 * both directions rather than only the happy one.
 *
 * The failure being guarded is a TESTNET address pasted into the mainnet field.
 * That mistake is silent: `utest1…` and `u1…` look alike at a glance, both are
 * called unified addresses, and the donor finds out after the funds are gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mainnetUnifiedOrEmpty } from "./config.ts";

// Shape only: long enough to clear the length floor, bech32m charset, u1 prefix.
const MAINNET_UA = "u1" + "qpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpq";

test("accepts a mainnet unified address", () => {
  assert.equal(mainnetUnifiedOrEmpty(MAINNET_UA), MAINNET_UA);
});

test("trims surrounding whitespace, since a pasted address usually carries some", () => {
  assert.equal(mainnetUnifiedOrEmpty(`  ${MAINNET_UA}\n`), MAINNET_UA);
});

test("REJECTS a testnet unified address, which is the mistake worth catching", () => {
  // The dangerous one. utest1 is also "a unified address", so a human reviewing
  // the env file sees nothing obviously wrong.
  assert.equal(mainnetUnifiedOrEmpty("utest1" + "qpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpq"), "");
});

test("rejects testnet sapling and transparent addresses too", () => {
  assert.equal(mainnetUnifiedOrEmpty("ztestsapling1abcdefghijklmnopqrstuvwxyz023456789"), "");
  assert.equal(mainnetUnifiedOrEmpty("tmEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAM"), "");
  assert.equal(mainnetUnifiedOrEmpty("t2EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAM"), "");
});

test("rejects a truncated paste, which is a real and silent way to lose funds", () => {
  assert.equal(mainnetUnifiedOrEmpty("u1qpqyqszqgpqy"), "");
});

test("rejects bech32-illegal characters", () => {
  // b, i, o and 1 are excluded from the bech32 charset precisely because they
  // are the characters people misread, so their presence means a transcription.
  assert.equal(mainnetUnifiedOrEmpty("u1" + "b".repeat(50)), "");
  assert.equal(mainnetUnifiedOrEmpty("u1" + "o".repeat(50)), "");
});

test("unset stays unset, and is not an error", () => {
  // Not configuring a donation address is a normal state for a fork of this
  // project, so it must not log or throw. It simply renders nothing.
  assert.equal(mainnetUnifiedOrEmpty(""), "");
  assert.equal(mainnetUnifiedOrEmpty("   "), "");
});

test("a rejected address yields exactly the same value as an unset one", () => {
  // The UI branches on truthiness alone, so if these ever diverge a rejected
  // address could render as an empty-but-present block.
  assert.equal(mainnetUnifiedOrEmpty("not-an-address"), mainnetUnifiedOrEmpty(""));
});
