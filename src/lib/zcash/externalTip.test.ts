import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// EVERYTHING this file needs from the module comes through ONE dynamic import, below,
// after the environment is set. A static import here is evaluated before any statement
// in the file, so the first version pinned HOSH_URL to its silent server AFTER the
// module had already read the real hosh.zec.rocks: the "hanging primary" test dialled
// Cloudflare-fronted production and passed on the luck of its latency (round 6, N1).
// The fallback list is pinned to a closed port for the same reason: unset, it is the
// real testnet.zec.rocks, one hosh hang away from being dialled.
// Silent by default (the hanging-primary test needs a primary that never answers).
// A test that needs a tip sets silentHoshHeight for its duration.
let silentHoshHeight: number | null = null;
const silentHosh = createServer((_req, res) => {
  if (silentHoshHeight == null) return; // never respond
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ servers: [{ chain: "test", online: true, height: silentHoshHeight }] }));
});
await new Promise<void>((r) => silentHosh.listen(0, "127.0.0.1", r));
const silentPort = (silentHosh.address() as { port: number }).port;
process.env.HOSH_URL = `http://127.0.0.1:${silentPort}/`;
process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:9"; // discard port, below the ephemeral range: refused at once
silentHosh.unref();
let silentHoshRequests = 0;
silentHosh.on("request", () => { silentHoshRequests += 1; });
const {
  heightFromBlockID, getExternalTipReading, getExternalTip, readingFor, MAX_AGE_MS_FOR_TESTS,
  fetchNetworkTipWithin, isIndependentTipEndpoint, dialLatestBlock, warmExternalTip, warmExternalTipNowForTests,
  resetExternalTipForTests,
} = await import("./externalTip.ts");

test("with no independent endpoint configured, the first warm says so ONCE, at boot, not one warning at a time mid-outage", async () => {
  // This file's LIGHTWALLETD_ENDPOINT is loopback, which the oracle skips, so the boot
  // check has something to say. Round 8 asked for the warning; round 9 found it untested.
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
  try {
    await warmExternalTip();
    await warmExternalTip();
  } finally {
    console.warn = realWarn;
  }
  const boot = warned.filter((w) => w.includes("no configured LIGHTWALLETD_ENDPOINT is a public third party"));
  assert.equal(boot.length, 1, `expected exactly one boot warning, got ${boot.length}: ${warned.join(" | ")}`);
  assert.match(boot[0], /https:\/\/127\.0\.0\.1:9/);
  assert.match(boot[0], /cached tip to age out \(5 min\)/);
});

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
  const before = silentHoshRequests;
  const given: number[] = [];
  const hanging = (_endpoint: string, timeoutMs: number) =>
    new Promise<number | null>((resolve) => { given.push(timeoutMs); setTimeout(() => resolve(null), timeoutMs); });
  const t0 = Date.now();
  const r = await fetchNetworkTipWithin(
    { hoshTimeoutMs: 200, fallbackTotalMs: 300 },
    ["https://a.example:443", "https://b.example:443", "https://c.example:443"],
    hanging,
  );
  const took = Date.now() - t0;
  // At least one: a background refresh from an earlier test may still be parked on the
  // same server. Zero is the bug this guards against (the module read the real URL).
  assert.ok(silentHoshRequests >= before + 1, "the primary that hung must be OUR silent server, not the real hosh");
  assert.equal(r.source, "none");
  assert.equal(r.height, null);
  assert.ok(took >= 450 && took < 900, `hosh 200 + legs sharing 300 must end near 500 ms, took ${took} ms`);
  assert.equal(given.length, 3, `every leg gets a turn on a shared budget, yet ${given.length} were tried`);
  assert.ok(given.every((g) => g <= 300), `a leg was given more than the whole budget: ${given.join(",")}`);
  assert.ok(given[0] <= 100 + 5, `three legs share 300 ms, the first was given ${given[0]}`);
  const sum = given.reduce((a, b) => a + b, 0);
  assert.ok(sum <= 300 + 15, `the legs together were given ${sum} ms of a 300 ms budget`);
});

test("a first endpoint that accepts and never answers does NOT hide the second: the share rule", async () => {
  // Before the share rule one shared deadline was consumed first-come, so a black-holed
  // first endpoint spent all of it and the healthy second was never reached, on this
  // attempt or any later one (round 6, N2).
  const legs: string[] = [];
  const blackholeThenAnswer = (endpoint: string, timeoutMs: number) => {
    legs.push(endpoint);
    if (endpoint.startsWith("https://dead")) return new Promise<number | null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    return Promise.resolve(4_336_000);
  };
  const r = await fetchNetworkTipWithin(
    { hoshTimeoutMs: 100, fallbackTotalMs: 300 },
    ["https://dead.example", "https://alive.example"],
    blackholeThenAnswer,
  );
  assert.deepEqual(legs, ["https://dead.example", "https://alive.example"]);
  assert.equal(r.source, "direct");
  assert.equal(r.height, 4_336_000);
});

test("a fallback that answers is USED, with its gRPC target as the host, after the primary fails", async () => {
  // The host is what grpc-js dialled, port included: "alive.example:443" for an https
  // URL with no port, "a.example:9067" for an explicit port.
  const answering = async (endpoint: string) => (endpoint === "https://alive.example" ? 4_336_000 : null);
  const r = await fetchNetworkTipWithin(
    { hoshTimeoutMs: 100, fallbackTotalMs: 500 },
    ["https://a.example:9067", "https://alive.example"],
    answering,
  );
  assert.equal(r.source, "direct");
  assert.equal(r.host, "alive.example:443");
  assert.equal(r.height, 4_336_000);
});

/* ------------------------------------------------- our own Zaino is not an oracle (#6, round 7) */

test("OUR OWN ZAINO IS NEVER THE TIP ORACLE: plaintext, private and local endpoints are skipped, public TLS ones are not", () => {
  // The sovereign path in the z3 docs points LIGHTWALLETD_ENDPOINT at http://zaino:8137,
  // our own indexer over our own Zebra. As a fallback tip it would compare our node
  // against itself: lag 0, safe, drips built against a frozen node.
  for (const e of ["http://zaino:8137", "http://zaino", "https://zaino:8137", "https://127.0.0.1:443", "https://10.0.0.5",
                   "https://172.16.4.4", "https://172.31.255.1", "https://192.168.1.10", "https://169.254.1.1", "https://100.64.0.1",
                   "https://localhost", "https://zaino.local", "https://zaino.internal", "https://[::1]:443", "https://[fd00::1]", "not a url",
                   // round 8's edges: mapped IPv4, trailing dots, more local suffixes, other reserved v6
                   "https://[::ffff:127.0.0.1]", "https://[::ffff:10.0.0.1]", "https://[::]", "https://[fec0::1]", "https://[64:ff9b::a00:1]",
                   "https://localhost.", "https://zaino.local.", "https://zaino.internal.", "https://zaino.lan", "https://zaino.home.arpa",
                   "https://zaino.intranet", "https://zaino.onion", "https://LOCALHOST", "https://[::FFFF:192.168.1.1]", "https://zaino.local.."]) {
    assert.equal(isIndependentTipEndpoint(e), false, e);
  }
  for (const e of ["https://testnet.zec.rocks:443", "https://testnet.zec.rocks", "https://lightwalletd.testnet.electriccoin.co:9067",
                   "https://172.32.0.1", "https://8.8.8.8", "https://[2607:f8b0::1]", "https://[::ffff:8.8.8.8]", "https://testnet.zec.rocks."]) {
    assert.equal(isIndependentTipEndpoint(e), true, e);
  }
});

test("the fallback loop dials ONLY the independent endpoints, and reports the one that answered", async () => {
  const dialled: string[] = [];
  const spy = async (endpoint: string) => { dialled.push(endpoint); return endpoint === "https://alive.example" ? 4_336_000 : null; };
  const r = await fetchNetworkTipWithin(
    { hoshTimeoutMs: 100, fallbackTotalMs: 500 },
    ["http://zaino:8137", "https://10.0.0.5:443", "https://alive.example"],
    spy,
  );
  assert.deepEqual(dialled, ["https://alive.example"], "a private or plaintext endpoint must never be asked for the tip");
  assert.equal(r.source, "direct");
  assert.equal(r.host, "alive.example:443");
  // Only our own endpoints: the gate runs on hosh alone, and here hosh is silent.
  dialled.length = 0;
  const none = await fetchNetworkTipWithin({ hoshTimeoutMs: 100, fallbackTotalMs: 300 }, ["http://zaino:8137"], spy);
  assert.deepEqual(dialled, []);
  assert.equal(none.source, "none");
});

test("THE DIAL HONOURS THE SCHEME: a plaintext gRPC server answers http://, and https:// against it fails", async () => {
  // The regression test round 7 asked for: every other test injects a fake leg, so the
  // real dial could be reverted to always-TLS-on-the-bare-host with everything green.
  const grpc = await import("@grpc/grpc-js");
  const raw = { requestSerialize: (b: Buffer) => b, requestDeserialize: (b: Buffer) => b, responseSerialize: (b: Buffer) => b, responseDeserialize: (b: Buffer) => b };
  const service = { GetLatestBlock: { path: "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock", requestStream: false, responseStream: false, ...raw } };
  const server = new grpc.Server();
  server.addService(service, {
    GetLatestBlock: (_call: unknown, cb: (e: null, b: Buffer) => void) => cb(null, Buffer.from([0x08, ...varint(4_496_032)])),
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))),
  );
  try {
    assert.equal(await dialLatestBlock(`http://127.0.0.1:${port}`, 3000), 4_496_032, "plain gRPC on an explicit http port");
    await assert.rejects(dialLatestBlock(`https://127.0.0.1:${port}`, 1500), "TLS against a plaintext server must not succeed");
  } finally {
    server.forceShutdown();
  }
});

/* ------------------------------- the cache is shared across module instances (#12) */

test("A TIP WARMED IN ONE MODULE INSTANCE IS VISIBLE IN ANOTHER: the cache lives on globalThis", async () => {
  // Next hands instrumentation and route handlers different module instances (#234), so a
  // module-level cache warmed at boot was invisible to the claim route and the first claim
  // after a deploy paid a whole oracle attempt inside the money path's wait. A second
  // import of this module is exactly that situation, and the only way to see it in a test.
  silentHoshHeight = 4_400_123;
  resetExternalTipForTests();
  try {
    await warmExternalTipNowForTests(); // what instrumentation does at boot
    assert.equal(getExternalTip(), 4_400_123, "precondition: this instance warmed");

    // A separate module instance, as Next gives the route handlers.
    const route = await import(`./externalTip.ts?instance=${Date.now()}`);
    assert.notEqual(route.getExternalTip, getExternalTip, "precondition: a distinct module instance");
    assert.equal(route.getExternalTip(), 4_400_123, "the second instance could not see the first instance's tip");
    assert.equal(route.getExternalTipReading().source, "hosh");
  } finally {
    silentHoshHeight = null;
    resetExternalTipForTests();
  }
});
