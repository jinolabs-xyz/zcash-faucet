/**
 * The external reference's encoder and decoder. Pure bytes, no network — the dial itself is
 * exercised by api-integration against the doubles.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBlockIDHeight, hashFromCompactBlock, REFERENCE_DEPTH } from "./externalBlock.ts";

test("a BlockID carries the height as field 1, and survives a round trip through the reader", async () => {
  const { heightFromBlockID } = await import("./externalTip.ts");
  for (const h of [0, 1, 127, 128, 4_367_000, 16_777_215]) {
    assert.equal(heightFromBlockID(encodeBlockIDHeight(h)), h, `height ${h}`);
  }
  // The tag is what makes it field 1 rather than a number in the right place.
  assert.equal(encodeBlockIDHeight(1)[0], 0x08);
});

test("the hash comes back in DISPLAY order, reversed from the wire", () => {
  // THE DEFECT THIS EXISTS TO PREVENT. lightwalletd sends internal byte order; zebra's
  // getblockhash - which the watchdog compares this against - prints display order, the reverse.
  // Two correct systems and a comparison that never matches, which would page FORK for ever.
  const wire = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) wire[i] = i;                      // 00 01 02 ... 1f
  const block = Buffer.concat([Buffer.from([0x1a, 32]), wire]);  // field 3, length 32
  const got = hashFromCompactBlock(block);
  assert.equal(got, Buffer.from(wire).reverse().toString("hex"));
  assert.equal(got?.slice(0, 2), "1f", "display order starts at the LAST wire byte");
  assert.notEqual(got, wire.toString("hex"), "wire order must not be what we publish");
});

test("a field that is not 32 bytes is not a block hash, whatever its number says", () => {
  // A truncated or renumbered field must answer null rather than a short string that would then
  // be compared against a real hash and never match - a silent permanent FORK page.
  const short = Buffer.concat([Buffer.from([0x1a, 4]), Buffer.from([1, 2, 3, 4])]);
  assert.equal(hashFromCompactBlock(short), null);
});

test("fields before the hash are skipped, not misread", () => {
  // A real CompactBlock carries protoVersion (1, varint) and height (2, varint) first. A reader
  // that stopped at the first length-delimited field it saw, or mis-skipped a varint, would
  // return the wrong bytes with total confidence.
  const wire = Buffer.alloc(32, 0xab);
  const block = Buffer.concat([
    Buffer.from([0x08, 0x01]),                    // field 1 varint = 1
    Buffer.from([0x10, 0xf8, 0xac, 0x85, 0x02]),  // field 2 varint, multi-byte
    Buffer.from([0x1a, 32]), wire,                // field 3, the hash
  ]);
  assert.equal(hashFromCompactBlock(block), Buffer.from(wire).reverse().toString("hex"));
});

test("it takes field 3 SPECIFICALLY, not the first length-delimited field it meets", () => {
  // THE ROW ABOVE DID NOT TEST THIS AND A MUTANT PROVED IT: a real CompactBlock puts protoVersion
  // and height (both varints) before the hash, so field 3 IS the first length-delimited field and
  // `field === 3` and `field >= 1` behave identically on it. The arm survived, and the honest
  // reading is that the row was weak rather than the arm badly aimed.
  //
  // THE FAILURE IT NOW GUARDS is the realistic one: we ask for the wrong thing, or lightwalletd
  // answers a different message, and a reader that grabs the first 32-byte field returns SOME
  // hash with total confidence. The watchdog then compares a wrong hash against zebra's and pages
  // FORK for ever. A wrong hash is far worse here than no hash, because no hash is visibly absent.
  const decoy = Buffer.alloc(32, 0x11);
  const real = Buffer.alloc(32, 0x22);
  const notACompactBlock = Buffer.concat([
    Buffer.from([0x0a, 32]), decoy,   // field 1, length-delimited, 32 bytes - a plausible hash
    Buffer.from([0x1a, 32]), real,    // field 3, the one we actually want
  ]);
  const got = hashFromCompactBlock(notACompactBlock);
  assert.equal(got, Buffer.from(real).reverse().toString("hex"), "must read field 3");
  assert.notEqual(got, Buffer.from(decoy).reverse().toString("hex"), "must NOT read field 1");
});

test("garbage answers null rather than a plausible string", () => {
  assert.equal(hashFromCompactBlock(Buffer.alloc(0)), null);
  assert.equal(hashFromCompactBlock(Buffer.from([0x1a])), null);          // length ran off the end
  assert.equal(hashFromCompactBlock(Buffer.from([0x1a, 0x20, 0x01])), null); // body truncated
  assert.equal(hashFromCompactBlock(Buffer.from([0x0f])), null);          // wire type 7, unknown
});

test("the reference depth is below the tip by more than an ordinary reorg", () => {
  // A comparison AT the tip would page on normal chain behaviour, which is how an alarm gets
  // switched off. This is the number that keeps a reorg from reading as a fork.
  assert.ok(REFERENCE_DEPTH >= 5, `too shallow to survive a reorg: ${REFERENCE_DEPTH}`);
  assert.ok(REFERENCE_DEPTH <= 100, `so deep the divergence is old news: ${REFERENCE_DEPTH}`);
});
