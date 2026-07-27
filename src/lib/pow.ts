/**
 * Proof-of-work claim gate (hashcash). Before a drip, the browser must find a
 * nonce so that sha256("<seed>:<nonce>") has `difficulty` leading zero bits.
 *
 * Challenges are STATELESS: the server signs {seed, difficulty, exp, ipHash}
 * with HMAC(RATE_LIMIT_SALT), so any instance can verify one without a shared
 * store. Difficulty is adaptive — a modest base, plus escalation for a client
 * that keeps hammering, plus a bump when the whole faucet is under pressure.
 *
 * This is one layer. It sits on top of the per-address cooldown and the daily
 * cap. Browser PoW is a speed bump, not a wall.
 *
 * v1 replay protection + the escalation/pressure counters are in-memory, so
 * they're per-instance. On a single box (our deploy) that's fine; a multi-
 * instance deploy would move the used-challenge set to the shared ledger.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
// Explicit .ts extension so `node --test` (type stripping resolves literal
// paths only) can load this module. Next's bundler accepts it too.
import { config } from "./config.ts";

const SALT = process.env.RATE_LIMIT_SALT ?? "";

export interface Challenge {
  seed: string;
  difficulty: number;
  exp: number; // unix seconds
  sig: string;
}
export interface Solution extends Challenge {
  nonce: string;
}

function sign(seed: string, difficulty: number, exp: number, ipHash: string): string {
  return createHmac("sha256", SALT).update(`${seed}.${difficulty}.${exp}.${ipHash}`).digest("hex");
}

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    for (let m = 0x80; m > 0; m >>= 1) {
      if (byte & m) return bits;
      bits++;
    }
    return bits;
  }
  return bits;
}

/* ── adaptive difficulty (in-memory sliding windows) ────────────────────── */
const REQ_WINDOW_MS = 10 * 60_000; // remember a client's requests for 10 min
const perIp = new Map<string, number[]>(); // ipHash -> request timestamps
const globalReqs: number[] = []; // all request timestamps (pressure signal)

function prune(list: number[], now: number) {
  while (list.length && list[0] < now - REQ_WINDOW_MS) list.shift();
}

function difficultyFor(ipHash: string, now: number): number {
  const mine = perIp.get(ipHash) ?? [];
  prune(mine, now);
  prune(globalReqs, now);
  const repeats = mine.length; // requests already made in the window
  const pressure = globalReqs.length >= 60 ? 3 : globalReqs.length >= 25 ? 2 : globalReqs.length >= 10 ? 1 : 0;
  const bits = config.pow.baseBits + repeats * config.pow.escalateBits + pressure;
  return Math.min(config.pow.maxBits, bits);
}

function recordRequest(ipHash: string, now: number) {
  const mine = perIp.get(ipHash) ?? [];
  mine.push(now);
  perIp.set(ipHash, mine);
  globalReqs.push(now);
  // opportunistic cleanup so the maps don't grow unbounded
  if (perIp.size > 5000) for (const [k, v] of perIp) { prune(v, now); if (!v.length) perIp.delete(k); }
}

/** Issue a fresh, signed challenge for this client. */
export function issueChallenge(ipHash: string): Challenge {
  const now = Date.now();
  const difficulty = difficultyFor(ipHash, now);
  recordRequest(ipHash, now);
  const seed = createHash("sha256").update(`${now}:${Math.random()}:${ipHash}`).digest("hex").slice(0, 32);
  const exp = Math.floor(now / 1000) + config.pow.ttlSeconds;
  return { seed, difficulty, exp, sig: sign(seed, difficulty, exp, ipHash) };
}

/* ── replay protection: each signed challenge is single-use ─────────────── */
const used = new Map<string, number>(); // sig -> exp (seconds)
function markUsed(sig: string, exp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (used.size > 20000) for (const [k, e] of used) if (e < now) used.delete(k);
  if (used.has(sig)) return false; // already spent
  used.set(sig, exp);
  return true;
}

export interface Verdict { ok: boolean; reason?: string }

/** Verify a solved challenge. Same ipHash the challenge was issued to. */
export function verifySolution(s: Solution, ipHash: string): Verdict {
  if (!s || !s.seed || typeof s.nonce !== "string") return { ok: false, reason: "Missing challenge solution." };
  const now = Math.floor(Date.now() / 1000);
  if (s.exp < now) return { ok: false, reason: "Challenge expired — refresh and try again." };
  if (s.difficulty < config.pow.baseBits - 1 || s.difficulty > config.pow.maxBits) return { ok: false, reason: "Bad challenge difficulty." };

  const expect = Buffer.from(sign(s.seed, s.difficulty, s.exp, ipHash), "hex");
  const got = Buffer.from(String(s.sig), "hex");
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return { ok: false, reason: "Invalid challenge signature." };

  const digest = createHash("sha256").update(`${s.seed}:${s.nonce}`).digest();
  if (leadingZeroBits(digest) < s.difficulty) return { ok: false, reason: "Proof of work does not meet the difficulty." };

  if (!markUsed(s.sig, s.exp)) return { ok: false, reason: "Challenge already used." };
  return { ok: true };
}
