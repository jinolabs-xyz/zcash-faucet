/*
 * PoW solver worker (static asset - loaded as new Worker("/pow-worker.js")).
 *
 * Given {seed, difficulty}, find a nonce so sha256("<seed>:<nonce>") has
 * >= difficulty leading zero bits. Runs off the main thread so the tab never
 * freezes. Served as a plain static file on purpose: routing it through the
 * bundler drags server-only modules into a browser compile. SHA-256 is inlined
 * so this has zero imports and produces the exact digest node:crypto does.
 */
"use strict";

var enc = new TextEncoder();

var K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

function sha256(msg) {
  var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  var l = msg.length;
  var bitLen = l * 8;
  var padded = ((((l + 8) >> 6) + 1) << 6) >>> 0; // multiple of 64, room for 0x80 + 8-byte length
  var m = new Uint8Array(padded);
  m.set(msg);
  m[l] = 0x80;
  var dv = new DataView(m.buffer);
  dv.setUint32(padded - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padded - 4, bitLen >>> 0, false);

  var w = new Uint32Array(64);
  for (var off = 0; off < padded; off += 64) {
    for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (i = 16; i < 64; i++) {
      var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (i = 0; i < 64; i++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  var out = new Uint8Array(32);
  var odv = new DataView(out.buffer);
  var hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (var j = 0; j < 8; j++) odv.setUint32(j * 4, hs[j] >>> 0, false);
  return out;
}

function leadingZeroBits(d) {
  var bits = 0;
  for (var i = 0; i < d.length; i++) {
    var x = d[i];
    if (x === 0) { bits += 8; continue; }
    for (var mask = 0x80; mask > 0; mask >>= 1) {
      if (x & mask) return bits;
      bits++;
    }
    return bits;
  }
  return bits;
}

self.onmessage = function (e) {
  var seed = e.data.seed;
  var difficulty = e.data.difficulty;
  var nonce = 0;
  var hashes = 0;
  var t0 = performance.now();
  for (;;) {
    hashes++;
    if (leadingZeroBits(sha256(enc.encode(seed + ":" + nonce))) >= difficulty) {
      self.postMessage({ type: "found", nonce: String(nonce), hashes: hashes, ms: performance.now() - t0 });
      return;
    }
    nonce++;
    if ((hashes & 0x1fff) === 0) {
      self.postMessage({ type: "progress", hashes: hashes, ms: performance.now() - t0 });
    }
  }
};
