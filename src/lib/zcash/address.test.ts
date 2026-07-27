import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTestnetAddress } from "./address.ts";

// Realistic-shaped fixtures: right prefix, right length, chars drawn from the
// format's own charset. The validator checks prefix + charset + length (no
// checksum decode yet, see the TODOs in address.ts), so these are exactly the
// strings it is specified to accept.
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const b32 = (n: number) => B32.repeat(Math.ceil(n / B32.length)).slice(0, n);
const UNIFIED = "utest1" + b32(207); // typical orchard+p2pkh UA data length
const SAPLING = "ztestsapling1" + b32(76);
const P2PKH = "tm" + "9fBPmzvCqTGZLPB2y6wUP9o7DBQjMK3S6".slice(0, 33); // 35 chars
const P2SH = "t2" + "8sVXZGeES9DWA9JOZ6ZjqWp9pTM6hs2t3".replace(/[0OIl]/g, "9").slice(0, 33);

test("accepts a unified testnet address and flags it shielded", () => {
  assert.deepEqual(validateTestnetAddress(UNIFIED), { valid: true, kind: "unified", shielded: true });
});

test("accepts a Sapling testnet address", () => {
  assert.deepEqual(validateTestnetAddress(SAPLING), { valid: true, kind: "sapling", shielded: true });
});

test("accepts transparent tm (P2PKH) and t2 (P2SH), flagged unshielded", () => {
  assert.deepEqual(validateTestnetAddress(P2PKH), { valid: true, kind: "transparent", shielded: false });
  assert.deepEqual(validateTestnetAddress(P2SH), { valid: true, kind: "transparent", shielded: false });
});

test("accepts regtest unified and Sapling prefixes", () => {
  assert.equal(validateTestnetAddress("uregtest1" + b32(60)).valid, true);
  assert.equal(validateTestnetAddress("zregtestsapling1" + b32(76)).valid, true);
});

test("trims surrounding whitespace before validating", () => {
  assert.equal(validateTestnetAddress("  " + P2PKH + "\n").valid, true);
});

test("rejects every mainnet prefix with the mainnet reason", () => {
  for (const addr of ["u1" + b32(100), "zs1" + b32(76), "t1dRJRY7GscZbGGGGGGGGGGGGGGGGGGGGGG", "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd"]) {
    const v = validateTestnetAddress(addr);
    assert.equal(v.valid, false, addr);
    assert.match(v.reason ?? "", /mainnet/i, addr);
  }
});

test("rejects empty and whitespace-only input", () => {
  for (const addr of ["", "   ", "\t\n"]) {
    const v = validateTestnetAddress(addr);
    assert.equal(v.valid, false);
    assert.match(v.reason ?? "", /empty/i);
  }
});

test("rejects an address over 512 chars as too long", () => {
  const v = validateTestnetAddress("utest1" + b32(600));
  assert.equal(v.valid, false);
  assert.match(v.reason ?? "", /too long/i);
});

test("rejects a unified address with data too short or off-charset", () => {
  // bech32 data excludes '1', 'b', 'i', 'o'
  for (const addr of ["utest1" + b32(5), "utest1" + "b".repeat(20), "utest1" + b32(10) + "1" + b32(10)]) {
    const v = validateTestnetAddress(addr);
    assert.equal(v.valid, false, addr);
    assert.match(v.reason ?? "", /malformed unified/i, addr);
  }
});

test("rejects a Sapling address with data too short", () => {
  const v = validateTestnetAddress("ztestsapling1" + b32(20));
  assert.equal(v.valid, false);
  assert.match(v.reason ?? "", /malformed sapling/i);
});

test("rejects transparent addresses at the wrong length or charset", () => {
  const cases = [
    "tm" + P2PKH.slice(2, 30), // 30 chars, too short
    P2PKH + "xxx", // 38 chars, too long
    "tm" + "0".repeat(33), // '0' is not base58
    "tm" + "O".repeat(33), // 'O' is not base58
  ];
  for (const addr of cases) {
    const v = validateTestnetAddress(addr);
    assert.equal(v.valid, false, addr);
    assert.match(v.reason ?? "", /malformed transparent/i, addr);
  }
});

test("rejects garbage with the unrecognized reason", () => {
  for (const addr of ["hello", "bc1qxyz", "0x52908400098527886E0F7030069857D2E4169EE7", "ztest1" + b32(40)]) {
    const v = validateTestnetAddress(addr);
    assert.equal(v.valid, false, addr);
    assert.match(v.reason ?? "", /unrecognized/i, addr);
  }
});

test("tolerates uppercase in bech32 data (lowercased before the charset check)", () => {
  assert.equal(validateTestnetAddress("utest1" + b32(40).toUpperCase()).valid, true);
});
