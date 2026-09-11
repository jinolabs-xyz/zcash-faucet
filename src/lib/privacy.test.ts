import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RATE_LIMIT_SALT = "privacy-test-salt";
const { fingerprintAddress, canonicalAddress } = await import("./privacy.ts");

test("a bech32 address in either letter case is one address to the ledger", () => {
  // Bech32 is case-insensitive by spec and the validator accepts both cases. Hashing
  // them apart let the same recipient claim twice; under one-per-IP that cost a second
  // connection, under five-per-IP it costs one more proof-of-work.
  const lower = "utest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  assert.equal(fingerprintAddress(lower), fingerprintAddress(lower.toUpperCase()));
  assert.equal(fingerprintAddress(" " + lower + "\n"), fingerprintAddress(lower), "whitespace is not identity either");
  assert.equal(canonicalAddress("ZTESTSAPLING1ABC"), "ztestsapling1abc");
});

test("a transparent address is NOT case-folded, because base58 is case-sensitive", () => {
  // tm and TM are different payloads. Folding them would merge two real addresses into
  // one fingerprint and refuse the second person for the first one's drip.
  const tm = "tmPTFGx26uRCFP57GWf41nrgZ7oV8mqg3q6";
  assert.notEqual(fingerprintAddress(tm), fingerprintAddress(tm.toLowerCase()));
  assert.equal(canonicalAddress(tm), tm);
});
