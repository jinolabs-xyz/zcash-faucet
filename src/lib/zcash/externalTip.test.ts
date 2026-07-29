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
