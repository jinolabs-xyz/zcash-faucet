/**
 * Central config, read once from the environment.
 * All amounts are handled as zatoshi (1 TAZ = 100_000_000 zatoshi) internally
 * to avoid floating-point drift; TAZ values in env are converted here.
 */

// Explicit .ts extension, same reason as pow.ts's config import: node --test
// (type stripping) resolves literal paths only, and config sits on the import
// chain of every test that touches pow or the senders.
import { saltRejectionReason } from "./saltGuard.ts";

export const ZATOSHI_PER_TAZ = 100_000_000n;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

export function tazToZatoshi(taz: number): bigint {
  // Round to nearest zatoshi.
  return BigInt(Math.round(taz * Number(ZATOSHI_PER_TAZ)));
}

/** Parse a comma-separated endpoint list; falls back to a sensible default. */
function endpointList(): string[] {
  const raw = process.env.LIGHTWALLETD_ENDPOINT ?? "https://testnet.zec.rocks:443";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ["https://testnet.zec.rocks:443"];
}

export const config = {
  dripTaz: num("FAUCET_DRIP_TAZ", 0.1),
  get dripZatoshi() {
    return tazToZatoshi(this.dripTaz);
  },
  cooldownSeconds: num("FAUCET_COOLDOWN_SECONDS", 86_400),
  dailyCapZatoshi: tazToZatoshi(num("FAUCET_DAILY_CAP_TAZ", 100)),

  // How many reverse proxies YOU operate in front of the app (nginx, Cloudflare,
  // Vercel, …). Each appends to X-Forwarded-For, so only the last N hops are
  // trustworthy — anything further left is client-supplied and spoofable. 0 =
  // no trusted proxy, so X-Forwarded-For is ignored entirely.
  trustedProxyCount: Math.max(0, Math.floor(num("TRUSTED_PROXY_COUNT", 0))),

  // Keep this much TAZ in the faucet wallet untouched (reserve floor). Below
  // drip + reserve the faucet reports "empty" instead of attempting a send.
  minReserveZatoshi: tazToZatoshi(num("FAUCET_MIN_RESERVE_TAZ", 0)),

  // Ordered list of lightwalletd/Zaino testnet endpoints; tried in order.
  lightwalletdEndpoints: endpointList(),
  get lightwalletdEndpoint() {
    return this.lightwalletdEndpoints[0]!;
  },
  sender: (process.env.FAUCET_SENDER ?? "zallet") as "real" | "zallet",
  walletSeed: process.env.FAUCET_WALLET_SEED ?? "",

  // Zallet backend (FAUCET_SENDER=zallet): a genuinely shielded faucet. Holds
  // Orchard notes and pays z→z via a running `zallet start` over JSON-RPC.
  zallet: {
    endpoint: process.env.ZALLET_RPC_URL ?? "http://127.0.0.1:28232/",
    user: process.env.ZALLET_RPC_USER ?? "",
    password: process.env.ZALLET_RPC_PASSWORD ?? "",
    // The faucet's own account UUID (z_getnewaccount) and one of its unified
    // addresses (z_getaddressforaccount) — spent-from in z_sendmany.
    account: process.env.ZALLET_ACCOUNT ?? "",
    address: process.env.ZALLET_ADDRESS ?? "",
    // Confirmations a note needs before the wallet will spend it (Zallet default 10).
    minConf: Math.max(0, Math.floor(num("ZALLET_MIN_CONF", 10))),
    // If the wallet is encrypted at rest, unlock it for this many seconds per send.
    passphrase: process.env.ZALLET_PASSPHRASE ?? "",
    unlockSeconds: Math.max(1, Math.floor(num("ZALLET_UNLOCK_SECONDS", 60))),
    rpcTimeoutMs: Math.max(1000, Math.floor(num("ZALLET_RPC_TIMEOUT_MS", 15_000))),
    // A shielded build+prove can take tens of seconds; give the opid room to land.
    opTimeoutMs: Math.max(5000, Math.floor(num("ZALLET_OP_TIMEOUT_MS", 180_000))),
    pollMs: Math.max(250, Math.floor(num("ZALLET_POLL_MS", 1500))),
  },

  // Reserve top-up loop (src/lib/reserve): start refilling when spendable
  // drops below low, stop once it reaches target. The gap between the two is
  // the hysteresis band that stops the miner flapping on and off.
  reserve: {
    targetZatoshi: tazToZatoshi(num("FAUCET_RESERVE_TARGET_TAZ", 15)),
    lowZatoshi: tazToZatoshi(num("FAUCET_RESERVE_LOW_TAZ", 5)),
    checkSeconds: Math.max(5, Math.floor(num("FAUCET_RESERVE_CHECK_SECONDS", 30))),
  },

  // Whether the refill loop may actually move funds (mine + shield). Off until
  // tip cutover: mining against a still-syncing node would fork us off-chain.
  miner: { active: process.env.FAUCET_MINER_ACTIVE === "true" },

  // Public address shown on /donate so people can refill the faucet. Unified,
  // so donations arrive shielded.
  donationAddress: process.env.FAUCET_DONATION_ADDRESS ?? "",
  // Transparent address the miner pays its coinbase to. Shown on /donate for
  // anyone who wants to point spare hashrate at us. Optional: unset just hides
  // that block, and it is a different address from the donation UA because a
  // coinbase cannot pay a shielded output directly.
  miningAddress: process.env.FAUCET_MINING_ADDRESS ?? "",

  // Ledger backend. "sqlite" = local file (dev / single box). "d1" = Cloudflare
  // D1 via the proxy Worker (survives Render's ephemeral disk). See worker/.
  dbBackend: (process.env.DB_BACKEND ?? "sqlite") as "sqlite" | "d1",
  d1ProxyUrl: process.env.D1_PROXY_URL ?? "",
  d1ProxySecret: process.env.D1_PROXY_SECRET ?? "",



  // Max sends waiting in the serial FIFO queue before we reject with "busy".
  sendQueueMaxPending: Math.max(1, Math.floor(num("SEND_QUEUE_MAX_PENDING", 20))),

  turnstile: {
    siteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
    secretKey: process.env.TURNSTILE_SECRET_KEY ?? "",
    get enabled() {
      return this.secretKey.length > 0;
    },
  },

  // Anti-abuse gate before a claim: "pow" (browser proof-of-work / hashcash),
  // "turnstile" (Cloudflare captcha), or "none". Default follows whatever is
  // configured: Turnstile if its secret is set, else none.
  challenge: (process.env.FAUCET_CHALLENGE ??
    (process.env.TURNSTILE_SECRET_KEY ? "turnstile" : "none")) as "pow" | "turnstile" | "none",

  pow: {
    // Base difficulty in leading zero bits of sha256(challenge:nonce). ~20 bits
    // is a couple seconds on a laptop, more on a phone — modest on purpose so a
    // first-time real user barely waits. Repeat claims escalate above this.
    baseBits: Math.max(8, Math.min(28, Math.floor(num("FAUCET_POW_BITS", 20)))),
    // Each recent claim from the same client adds this many bits (quadratic cost
    // for anyone hammering the faucet, unnoticeable for a one-off human).
    escalateBits: Math.max(0, Math.floor(num("FAUCET_POW_ESCALATE_BITS", 2))),
    // Hard cap so difficulty can't run away into a device-killing wait.
    maxBits: Math.max(12, Math.min(30, Math.floor(num("FAUCET_POW_MAX_BITS", 26)))),
    // How long a signed challenge is valid before the browser has to fetch a new one.
    ttlSeconds: Math.max(30, Math.floor(num("FAUCET_POW_TTL_SECONDS", 180))),
  },

  network: "testnet" as const,
} as const;

// A low mark at or above the target would make the hysteresis contradictory
// (start and stop at once). Fail loud at boot, not weirdly at runtime.
if (config.reserve.lowZatoshi >= config.reserve.targetZatoshi) {
  throw new Error(
    "FAUCET_RESERVE_LOW_TAZ must be below FAUCET_RESERVE_TARGET_TAZ " +
      `(got low=${config.reserve.lowZatoshi} zat, target=${config.reserve.targetZatoshi} zat).`,
  );
}

// A production faucet with an active challenge gate must not run on an empty
// or template-placeholder RATE_LIMIT_SALT: the PoW gate signs challenges with
// it, so a known salt makes the gate forgeable. Same fail-loud posture.
const saltProblem = saltRejectionReason({
  salt: process.env.RATE_LIMIT_SALT ?? "",
  production: process.env.NODE_ENV === "production",
  challenge: config.challenge,
});
if (saltProblem) throw new Error(saltProblem);
