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
// HOSH_URL is read at import, so the primary this file's attempt-bound test hangs on is
// started first: a server that never answers, standing in for a hosh that is up and slow.
import { createServer } from "node:http";
const silentHosh = createServer(() => { /* never respond */ });
await new Promise<void>((r) => silentHosh.listen(0, "127.0.0.1", r));
process.env.HOSH_URL = `http://127.0.0.1:${(silentHosh.address() as { port: number }).port}/`;
silentHosh.unref();
const { getExternalTipReading, getExternalTip, readingFor, MAX_AGE_MS_FOR_TESTS, fetchNetworkTipWithin } = await import("./externalTip.ts");

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

/* ------------------------------------------------- one attempt is bounded (#6, round 5) */

test("an attempt with a HANGING primary and hanging fallbacks ends at hosh + the fallback budget, not hosh + a budget per endpoint", async () => {
  // Review measured one attempt at 10 s against a 7 s wait: hosh to its abort, then a
  // 5 s gRPC leg, and a second endpoint would have added another. The legs now share one
  // deadline. hosh (the silent server above) never answers; the fallback hangs until its
  // deadline like a black-holed TCP connect does, and reports the deadline it was given.
  const given: number[] = [];
  const hanging = (_host: string, timeoutMs: number) =>
    new Promise<number | null>((resolve) => { given.push(timeoutMs); setTimeout(() => resolve(null), timeoutMs); });
  const t0 = Date.now();
  const r = await fetchNetworkTipWithin(
    { hoshTimeoutMs: 200, fallbackTotalMs: 300 },
    ["https://a.example:443", "https://b.example:443", "https://c.example:443"],
    hanging,
  );
  const took = Date.now() - t0;
  assert.equal(r.source, "none");
  assert.equal(r.height, null);
  assert.ok(took < 900, `three hanging legs must share the 300 ms budget, took ${took} ms`);
  assert.ok(given.length >= 1 && given[0] <= 300, `the first leg was given ${given[0]} ms of a 300 ms budget`);
  assert.ok(given.every((g) => g <= 300), `a leg was given more than the whole budget: ${given.join(",")}`);
  assert.ok(given.length < 3, `a spent budget must stop the loop, yet ${given.length} legs were tried`);
});

test("a fallback that answers inside the budget is USED, with its host, after the primary fails", async () => {
  // new URL() drops a default port, so the host handed to gRPC is "b.example", the way
  // production hands "testnet.zec.rocks" (grpc-js dials 443 for TLS credentials).
  const answering = async (host: string) => (host === "b.example" ? 4_336_000 : null);
  const r = await fetchNetworkTipWithin(
    { hoshTimeoutMs: 100, fallbackTotalMs: 500 },
    ["https://a.example:443", "https://b.example:443"],
    answering,
  );
  assert.equal(r.source, "direct");
  assert.equal(r.host, "b.example");
  assert.equal(r.height, 4_336_000);
});
