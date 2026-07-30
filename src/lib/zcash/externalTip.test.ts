import { test } from "node:test";
import assert from "node:assert/strict";
import { heightFromBlockID } from "./externalTip.ts";

// Encode a number as a protobuf varint (the wire form of BlockID.height).
function varint(n: number): number[] {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}

test("reads the height (field 1 varint) out of a BlockID", () => {
  const height = 4218522;
  const hash = Buffer.from("aabbccddee", "hex");
  // 0x08 = field 1, wire 0 (varint); 0x12 = field 2, wire 2 (length-delimited)
  const buf = Buffer.from([0x08, ...varint(height), 0x12, hash.length, ...hash]);
  assert.equal(heightFromBlockID(buf), height);
});

test("skips the hash field even when it is serialized first", () => {
  const height = 100;
  const hash = Buffer.from("deadbeef", "hex");
  const buf = Buffer.from([0x12, hash.length, ...hash, 0x08, ...varint(height)]);
  assert.equal(heightFromBlockID(buf), height);
});

test("a multi-byte varint height decodes correctly", () => {
  // A real testnet height spans several varint bytes, exercising the shift loop.
  assert.ok(varint(4218522).length > 1, "should be a multi-byte varint");
  assert.equal(heightFromBlockID(Buffer.from([0x08, ...varint(4218522)])), 4218522);
});

test("no height field means null, never a fabricated number", () => {
  const hash = Buffer.from("00", "hex");
  assert.equal(heightFromBlockID(Buffer.from([0x12, hash.length, ...hash])), null);
  assert.equal(heightFromBlockID(Buffer.alloc(0)), null);
});

test("a truncated height varint returns null, never a smaller wrong number", () => {
  // 0x08 = height field, then a varint that keeps its continuation bit set but
  // the buffer ends. Must be null (the safe direction is not-a-number, since a
  // smaller number would falsely read as "not frozen").
  assert.equal(heightFromBlockID(Buffer.from([0x08, 0x80])), null);
  assert.equal(heightFromBlockID(Buffer.from([0x08, 0xda, 0x9d, 0x81])), null);
});

test("a truncated length-delimited field returns null, not a misread height", () => {
  // 0x12 = hash field with a truncated length prefix, then nothing.
  assert.equal(heightFromBlockID(Buffer.from([0x12, 0x80])), null);
});

/* ------------------------------------------------- tip provenance (#227) */

/**
 * Against the PURE age rule, because the cache is module state and the only state a
 * unit test can reach through the accessors is a cold one. My first version of these
 * tests asserted the right properties in that cold state, where they hold trivially,
 * and BOTH sabotages passed. Extracting readingFor is what made the interesting
 * states reachable.
 */
const { getExternalTipReading, getExternalTip, readingFor, MAX_AGE_MS_FOR_TESTS } = await import("./externalTip.ts");

const FRESH = { height: 4_224_367, at: 1_000_000, source: "hosh" as const, host: null };
const DIRECT = { height: 4_224_365, at: 1_000_000, source: "direct" as const, host: "testnet.zec.rocks:443" };

test("a fresh reading carries its label and host", () => {
  const r = readingFor(DIRECT, 1_000_000);
  assert.equal(r.height, 4_224_365);
  assert.equal(r.source, "direct");
  assert.equal(r.host, "testnet.zec.rocks:443");
});

test("a STALE reading reports source none, so no label survives an absent height", () => {
  // The property with teeth. A caller seeing source "hosh" beside a null height
  // would conclude something was checked when nothing was.
  const r = readingFor(FRESH, 1_000_000 + MAX_AGE_MS_FOR_TESTS + 1);
  assert.equal(r.height, null, "a stale height must not be served");
  assert.equal(r.source, "none", "a stale label survived an absent height");
  assert.equal(r.host, null);
});

test("a cold cache is source none, not a label describing where a value would come from", () => {
  const r = readingFor({ height: null, at: 0, source: "none", host: null }, 5_000_000);
  assert.equal(r.height, null);
  assert.equal(r.source, "none");
});

test("a null height with a live label is still reported as none", () => {
  // Defence in depth: if a refresh ever recorded a source without a height, the
  // reading must not pass the label on. Reachable only through this function, which
  // is exactly why it is worth pinning.
  const r = readingFor({ height: null, at: 1_000_000, source: "hosh", host: null }, 1_000_001);
  assert.equal(r.source, "none", "a label was served beside a null height");
});

test("just inside the age limit is still served, so the boundary is not off by one", () => {
  assert.equal(readingFor(FRESH, 1_000_000 + MAX_AGE_MS_FOR_TESTS).height, 4_224_367);
  assert.equal(readingFor(FRESH, 1_000_000 + MAX_AGE_MS_FOR_TESTS + 1).height, null);
});

test("getExternalTip returns exactly the reading's height", () => {
  // The old accessor is what readiness and the shield gate use, and #227 must not
  // change what they see.
  assert.equal(getExternalTip(), getExternalTipReading().height);
});
