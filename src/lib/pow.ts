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
 * Replay protection is persistent: a spent challenge is recorded in the ledger,
 * so a restart cannot un-spend it (see spendChallenge). That matters because
 * the watchdog restarts this process on a hang and every deploy restarts it on
 * purpose, and an in-memory set would hand every live challenge back inside its
 * TTL.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
// Explicit .ts extension so `node --test` (type stripping resolves literal
// paths only) can load this module. Next's bundler accepts it too.
import { config, num } from "./config.ts";
import { solvableCeilingBits, ttlSecondsFor } from "./powBudget.ts";
import { spendChallenge } from "./db/index.ts";

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

/* ── adaptive difficulty (in-memory sliding windows) ─────────────────────
 * These stay in memory on purpose, unlike the replay set. Persisting them
 * would mean a ledger write on every challenge ISSUE, the cheapest and most
 * spammable endpoint we have, to protect a signal that only tunes difficulty.
 * A restart therefore hands a hammering client a fresh slate, which costs them
 * a few bits of work. What a restart does NOT reset is the ledger: the
 * per-address cooldown and the daily cap are the real ceiling on how much
 * anyone can take, and those are durable. Escalation is a speed bump on top of
 * a wall, so a bump that resets is an acceptable trade for keeping the hot
 * path free of writes.
 */
/**
 * How long a client's attempts are remembered for escalation.
 *
 * Widened from 10 minutes to an hour, and this is the lever that actually targets
 * farming rather than taxing everyone (#196). A real person claims once, so the
 * window length is invisible to them. A farmer PACES: at ten minutes, one attempt
 * every eleven minutes reset escalation completely and they paid base difficulty
 * forever. An hour makes the same evasion six times slower for no cost to anyone
 * claiming legitimately.
 *
 * Env-tunable because the right value depends on abuse we have not observed yet,
 * and there is currently no visibility into claim patterns to tune it against.
 */
export const REQ_WINDOW_MS = Math.max(60_000, Math.floor(num("FAUCET_POW_WINDOW_SECONDS", 3600) * 1000));
const perIp = new Map<string, number[]>(); // ipHash -> request timestamps
/**
 * Attempts per SUBNET, so rotating IPs inside one range does not reset escalation
 * (#196). A cloud provider hands one person thousands of addresses in a /24, so
 * keying escalation on the IP alone meant a farmer paid base difficulty forever: 50
 * attempts from 50 addresses looked like 50 first-time users.
 *
 * Residential users do not cluster this way, which is the same reason the daily cap
 * is per-subnet already. An honest claimer makes one attempt and never reaches the
 * second bucket at all.
 */
const perSubnet = new Map<string, number[]>(); // subnetHash -> request timestamps
const globalReqs: number[] = []; // all request timestamps (pressure signal)

function prune(list: number[], now: number) {
  while (list.length && list[0] < now - REQ_WINDOW_MS) list.shift();
}

function difficultyFor(ipHash: string, subnetHash: string | null, now: number): number {
  const mine = perIp.get(ipHash) ?? [];
  prune(mine, now);
  prune(globalReqs, now);
  const range = subnetHash ? (perSubnet.get(subnetHash) ?? []) : [];
  prune(range, now);
  // MAX rather than sum. Both buckets see the same attempt when one address makes it,
  // so adding them would double every honest user's escalation to buy nothing. The max
  // is what makes this cost a farmer and cost a single claimant exactly nothing.
  const repeats = Math.max(mine.length, range.length); // attempts already in the window
  // Global pressure. Thresholds tightened with the window widening: they count
  // requests inside REQ_WINDOW_MS, so leaving them at 10/25/60 after a 6x longer
  // window would have made pressure fire six times more readily by accident, which
  // punishes legitimate users during any busy hour. Scaled with the window so the
  // RATE they represent is unchanged, then floored so a short window stays sane.
  const perHour = (n: number) => Math.max(n, Math.round((n * REQ_WINDOW_MS) / 600_000));
  const pressure =
    globalReqs.length >= perHour(60) ? 3 : globalReqs.length >= perHour(25) ? 2 : globalReqs.length >= perHour(10) ? 1 : 0;
  const bits = config.pow.baseBits + repeats * config.pow.escalateBits + pressure;
  // Two ceilings, and the second one is not optional. maxBits is what the
  // operator asked for; the solvable ceiling is what a browser can actually
  // answer inside the challenge's own life (#132). Issuing above it is not a
  // harder gate, it is a gate nobody can pass.
  return Math.min(config.pow.maxBits, solvableCeiling(), bits);
}

/** Config is read once at boot, so the ceiling is constant for the process. */
let ceilingCache: number | null = null;
function solvableCeiling(): number {
  return (ceilingCache ??= solvableCeilingBits(config.pow.baseBits, config.pow.ttlSeconds));
}

/**
 * Escalation counts ATTEMPTS, never fetches. The UI fetches a challenge on its
 * own, and a 403 used to tell people to refresh, so counting fetches punished
 * users for the client's behaviour and for their own retries, then re-armed the
 * same difficulty on the way back (#132).
 */
function recordRequest(ipHash: string, subnetHash: string | null, now: number) {
  if (subnetHash) {
    const range = perSubnet.get(subnetHash) ?? [];
    prune(range, now);
    range.push(now);
    perSubnet.set(subnetHash, range);
  }
  const mine = perIp.get(ipHash) ?? [];
  mine.push(now);
  perIp.set(ipHash, mine);
  globalReqs.push(now);
  // opportunistic cleanup so the maps don't grow unbounded
  if (perIp.size > 5000) for (const [k, v] of perIp) { prune(v, now); if (!v.length) perIp.delete(k); }
}

/** Issue a fresh, signed challenge for this client. */
export function issueChallenge(ipHash: string, subnetHash: string | null = null): Challenge {
  const now = Date.now();
  const difficulty = difficultyFor(ipHash, subnetHash, now);
  const seed = createHash("sha256").update(`${now}:${Math.random()}:${ipHash}`).digest("hex").slice(0, 32);
  // A harder challenge lives longer. Cushion, not guarantee: see powBudget.ts.
  const exp = Math.floor(now / 1000) + ttlSecondsFor(difficulty, config.pow.baseBits, config.pow.ttlSeconds);
  return { seed, difficulty, exp, sig: sign(seed, difficulty, exp, ipHash) };
}

export interface Verdict { ok: boolean; reason?: string }

/**
 * Verify a solved challenge. Same ipHash the challenge was issued to.
 *
 * Async because replay protection lives in the ledger: the spend has to survive
 * a restart, and the D1 backend is an HTTP round-trip. The cheap checks run
 * first so a junk solution never reaches the database.
 */
export async function verifySolution(s: Solution, ipHash: string, subnetHash: string | null = null): Promise<Verdict> {
  if (!s || !s.seed || typeof s.nonce !== "string") return { ok: false, reason: "Missing challenge solution." };
  const now = Math.floor(Date.now() / 1000);
  if (s.exp < now) return { ok: false, reason: "That challenge expired. The gate is busy right now, so come back in a few minutes." };
  if (s.difficulty < config.pow.baseBits - 1 || s.difficulty > config.pow.maxBits) return { ok: false, reason: "Bad challenge difficulty." };

  const expect = Buffer.from(sign(s.seed, s.difficulty, s.exp, ipHash), "hex");
  const got = Buffer.from(String(s.sig), "hex");
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return { ok: false, reason: "Invalid challenge signature." };

  // Count it now, not earlier: the signature proves this is a challenge we
  // issued to this client, so junk POSTs cannot escalate a shared IP.
  recordRequest(ipHash, subnetHash, Date.now());

  const digest = createHash("sha256").update(`${s.seed}:${s.nonce}`).digest();
  if (leadingZeroBits(digest) < s.difficulty) return { ok: false, reason: "Proof of work does not meet the difficulty." };

  // Last, because it is the only check that writes: burn the challenge. The
  // insert is the mutex, so two requests racing the same solution cannot both
  // win, on either ledger backend.
  if (!(await spendChallenge(s.sig, s.exp, now))) {
    return { ok: false, reason: "Challenge already used." };
  }
  return { ok: true };
}
