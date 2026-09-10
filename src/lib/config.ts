/**
 * Central config, read once from the environment.
 * All amounts are handled as zatoshi (1 TAZ = 100_000_000 zatoshi) internally
 * to avoid floating-point drift; TAZ values in env are converted here.
 */

// Explicit .ts extension, same reason as pow.ts's config import: node --test
// (type stripping) resolves literal paths only, and config sits on the import
// chain of every test that touches pow or the senders.
import { saltRejectionReason } from "./saltGuard.ts";
import { defaultTaskDeadlineMs, senderWorstCaseMs } from "./zcash/sendBudget.ts";

export const ZATOSHI_PER_TAZ = 100_000_000n;

export const SENDERS = ["zallet", "real"] as const;
export type SenderKind = (typeof SENDERS)[number];

/**
 * Refuse to guess. An unrecognised value used to fall through to the real
 * transparent sender, so a stale FAUCET_SENDER=mock left in a box env would
 * silently route drips at the hot wallet.
 */
function senderFromEnv(): SenderKind {
  const raw = (process.env.FAUCET_SENDER ?? "zallet").trim();
  if ((SENDERS as readonly string[]).includes(raw)) return raw as SenderKind;
  throw new Error(
    `FAUCET_SENDER must be one of ${SENDERS.join(" | ")}, got "${raw}". ` +
      (raw === "mock"
        ? "Mock mode was removed: point FAUCET_SENDER=zallet at a real wallet, or at scripts/fake-zallet.mjs for local work."
        : "Refusing to start rather than pick a sender for you."),
  );
}

const CHALLENGES = ["pow", "turnstile", "none"] as const;
export type ChallengeKind = (typeof CHALLENGES)[number];

/**
 * The anti-abuse gate, parsed the way the sender is: a value this file cannot read
 * REFUSES TO BOOT. It used to be a cast, so `Pow`, `captcha` or `turnstyle` compared
 * equal to neither branch in the claim route and the gate was simply not there,
 * with nothing in the log to say so (risk register #10). An empty value is unset,
 * the same rule num() applies.
 *
 * THE DEFAULT IS POW, FULL STOP. A set TURNSTILE_SECRET_KEY used to flip it to turnstile
 * on its own, and turnstile is not a mode this project can serve: the page renders no
 * widget and sends no token, so every claim is a 403. An operator who followed the Render
 * deploy page (set both Turnstile keys) got a faucet that refused everyone. The key alone
 * changes nothing now, and asking for turnstile by name refuses to boot in
 * assertServingConfig(). It still parses, so `next build` (which imports every route with
 * whatever env it has) cannot be broken by the word; it is refused where traffic starts.
 */
function challengeFromEnv(): ChallengeKind {
  const raw = (process.env.FAUCET_CHALLENGE ?? "").trim();
  if (raw === "") return "pow";
  if ((CHALLENGES as readonly string[]).includes(raw)) return raw as ChallengeKind;
  throw new Error(
    `FAUCET_CHALLENGE must be pow or none, got "${raw}" (turnstile is a word this parses and refuses to serve). ` +
      "An unreadable value used to switch the anti-abuse gate off without a word; refusing to start instead.",
  );
}

/**
 * Parse an env var as a number, or REFUSE TO BOOT. Exported because the same rule
 * has to hold outside this file: a threshold that silently becomes NaN disables
 * whatever it guards, and `x > NaN` is false, so the guard fails OPEN. Failing to
 * start on a value we cannot parse is the same discipline as refusing to shield on
 * a tip we cannot verify.
 */
export function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

/**
 * A whole number of seconds, where 0 is a deliberate OFF and anything else invalid is
 * a mistake worth refusing at boot.
 *
 * Math.max(0, Math.floor(...)) looked equivalent and was not: it silently turned -1 and
 * 0.5 into 0, and 0 here means harvesting is disabled. A typo in the knob that decides
 * how often the faucet moves money would have restored, quietly and at boot, exactly
 * the money-stranding behaviour this setting exists to end.
 */
export function wholeSeconds(name: string, fallback: number): number {
  const n = num(name, fallback);
  if (n < 0 || !Number.isInteger(n)) {
    throw new Error(`Env ${name} must be a whole number of seconds (0 to disable), got "${process.env[name]}"`);
  }
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

/**
 * Zallet's own send timings, hoisted out of the config literal because the send
 * queue's backstop deadline is DERIVED from them (#88). The backstop has to sit
 * above whatever the sender's own bounds already allow, and a literal would
 * start firing early the moment an operator raised ZALLET_OP_TIMEOUT_MS.
 */
const zalletTimings = {
  rpcTimeoutMs: Math.max(1000, Math.floor(num("ZALLET_RPC_TIMEOUT_MS", 15_000))),
  // A shielded build+prove can take tens of seconds; give the opid room to land.
  opTimeoutMs: Math.max(5000, Math.floor(num("ZALLET_OP_TIMEOUT_MS", 180_000))),
  pollMs: Math.max(250, Math.floor(num("ZALLET_POLL_MS", 1500))),
};

/**
 * Accept a MAINNET unified address, or nothing at all.
 *
 * This is the only place in the app that handles an address for real money, and
 * the surrounding site is entirely testnet, so the failure we are guarding is a
 * testnet address being pasted into a mainnet field. That mistake is silent:
 * `utest1…` and `u1…` look alike at a glance, both are "unified addresses", and
 * the donor only discovers the problem after the funds are gone.
 *
 * Prefix and charset only. This is not a checksum, so it cannot catch a typo in
 * the middle, and it is not claimed to: it catches the wrong NETWORK and obvious
 * junk, which is the mistake an operator actually makes. The address still wants
 * a real send tested against it before it goes in front of anybody.
 */
export function mainnetUnifiedOrEmpty(raw: string): string {
  const addr = raw.trim();
  if (!addr) return "";
  if (addr.startsWith("utest1") || addr.startsWith("ztestsapling") || /^t[m2]/.test(addr)) {
    console.error(
      `[config] FAUCET_MAINTENANCE_ADDRESS looks like a TESTNET address (${addr.slice(0, 8)}…). ` +
        "That field is for mainnet ZEC donations, so it is being ignored rather than shown. " +
        "Nothing else is affected.",
    );
    return "";
  }
  // Bech32m: "u1" then the lowercase bech32 charset. Unified addresses are long,
  // so a short string is a truncated paste rather than an unusual address.
  if (!/^u1[023456789acdefghjklmnpqrstuvwxyz]{40,}$/.test(addr)) {
    console.error(
      "[config] FAUCET_MAINTENANCE_ADDRESS is not a mainnet unified address (expected u1… bech32m). " +
        "Ignoring it: showing a doubtful address for real funds is worse than showing none.",
    );
    return "";
  }
  return addr;
}

export const config = {
  dripTaz: num("FAUCET_DRIP_TAZ", 0.1),
  get dripZatoshi() {
    return tazToZatoshi(this.dripTaz);
  },
  cooldownSeconds: num("FAUCET_COOLDOWN_SECONDS", 86_400),
  dailyCapZatoshi: tazToZatoshi(num("FAUCET_DAILY_CAP_TAZ", 100)),

  /**
   * Claims allowed from one SUBNET per rolling 24h (#196).
   *
   * The per-IP cooldown already limits one address to one claim a day, so a /24
   * currently permits 256. This is the lever that makes a block of cloud IPs cost
   * what a block of cloud IPs should, while a residential claimer never meets it.
   *
   * THE NUMBER IS A JUDGEMENT, NOT A MEASUREMENT, and it is deliberately generous.
   * Too low turns away real people who share an ISP block, which is the same harm
   * the datacenter-range idea carries and the reason it is not first. Too high just
   * does nothing. We have no data on real subnet spread yet, which is what the
   * farming counts (#214) exist to produce, so this starts loose and tightens once
   * the counts say what normal looks like.
   */
  subnetDailyMax: Math.max(1, Math.floor(num("FAUCET_SUBNET_DAILY_MAX", 20))),

  // How many reverse proxies YOU operate in front of the app (nginx, Cloudflare,
  // Vercel, …). Each appends to X-Forwarded-For, so only the last N hops are
  // trustworthy - anything further left is client-supplied and spoofable. 0 =
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
  sender: senderFromEnv(),
  walletSeed: process.env.FAUCET_WALLET_SEED ?? "",

  // Zallet backend (FAUCET_SENDER=zallet): a genuinely shielded faucet. Holds
  // Orchard notes and pays z→z via a running `zallet start` over JSON-RPC.
  zallet: {
    endpoint: process.env.ZALLET_RPC_URL ?? "http://127.0.0.1:28232/",
    user: process.env.ZALLET_RPC_USER ?? "",
    password: process.env.ZALLET_RPC_PASSWORD ?? "",
    // The faucet's own account UUID (z_getnewaccount) and one of its unified
    // addresses (z_getaddressforaccount) - spent-from in z_sendmany.
    account: process.env.ZALLET_ACCOUNT ?? "",
    address: process.env.ZALLET_ADDRESS ?? "",
    // Confirmations a note needs before the wallet will spend it (Zallet default 10).
    minConf: Math.max(0, Math.floor(num("ZALLET_MIN_CONF", 10))),
    // If the wallet is encrypted at rest, unlock it for this many seconds per send.
    passphrase: process.env.ZALLET_PASSPHRASE ?? "",
    unlockSeconds: Math.max(1, Math.floor(num("ZALLET_UNLOCK_SECONDS", 60))),
    ...zalletTimings,
  },

  // Reserve top-up loop (src/lib/reserve): start refilling when spendable
  // drops below low, stop once it reaches target. The gap between the two is
  // the hysteresis band that stops the miner flapping on and off.
  reserve: {
    targetZatoshi: tazToZatoshi(num("FAUCET_RESERVE_TARGET_TAZ", 15)),
    lowZatoshi: tazToZatoshi(num("FAUCET_RESERVE_LOW_TAZ", 5)),
    checkSeconds: Math.max(5, Math.floor(num("FAUCET_RESERVE_CHECK_SECONDS", 30))),

    // Whether the loop may sweep coinbase we already own into the wallet.
    // Deliberately NOT the same switch as mining (#172): shielding our own
    // coinbase is a self-transfer with no fork risk, while mining on a syncing
    // node is what forks us. One flag for both meant turning mining off also
    // turned fund recovery off, and 47.5 TAZ sat unswept through a shortage.
    // Default false because it broadcasts a transaction, so it stays opt-in.
    shieldCoinbase: process.env.FAUCET_SHIELD_COINBASE === "true",

    /**
     * HARVEST: sweep transparent coinbase because it EXISTS, not because the
     * shielded side ran low.
     *
     * The refill rule above is demand-driven - it shields when spendable falls
     * under lowZat and stops at targetZat. That refills what we spend and never
     * harvests what we mine, so on a faucet that mines continuously the
     * transparent pile only grows. Measured on the live box 2026-09-10: 1801 TAZ
     * drippable, 1778 TAZ stranded transparent, and 1346 unspent coinbase UTXOs
     * behind a trigger that had not fired since July.
     *
     * The count is the trigger, not the value. A shield costs one transaction
     * whatever it carries, z_shieldcoinbase takes at most SHIELD_UTXO_LIMIT (50)
     * UTXOs per call, and an unbounded UTXO set is its own problem: 1346 of them
     * is 27 passes before the money is usable. One batch's worth is therefore the
     * natural unit of "enough to be worth a transaction".
     *
     * The sweep is also the probe. While idle we cannot see new coinbase arrive -
     * remainingUTXOs only updates after a sweep - so the loop attempts one on an
     * interval, and z_shieldcoinbase answers both questions at once: it shields a
     * batch and reports what is left. A backlog then drains on consecutive ticks
     * without waiting out the interval each time.
     *
     * 0 turns harvesting off entirely, which is the only way to get the old
     * demand-only behaviour back.
     */
    harvestIntervalSeconds: wholeSeconds("FAUCET_HARVEST_INTERVAL_SECONDS", 3600),
    /**
     * Coinbase UTXOs that make a harvest worth a transaction. Defaults to one
     * full shield batch: below this a sweep spends a fee to move a fraction of
     * what the next one would.
     */
    harvestMinUTXOs: Math.max(1, Math.floor(num("FAUCET_HARVEST_MIN_UTXOS", 50))),
  },

  // Whether we may MINE. The app itself never mines, that is the miner container
  // and zebra, so this gates nothing here except arming the reserve loop to
  // OBSERVE. Mining on a still-syncing node would fork us off the real chain,
  // which is why it defaults off, and why it is not the switch for shielding.
  //
  // `active` is INTENT and stays intent. It is what an operator configured, and its
  // job here is arming the reserve loop. What it must never again be is the answer to
  // "is the miner working", which is what /api/status served for months: an env flag
  // cannot be false while the miner is broken, and it read "on" for 70 minutes while
  // the miner errored every 5 seconds on a stale auth cookie.
  //
  // Observation comes from `heartbeatPath` instead, a file the miner writes and we
  // only read. Intent and reality are separate facts and come from separate sources,
  // so when they disagree that is a finding rather than a contradiction.
  //
  // No default path on purpose. A default would point somewhere plausible and read a
  // file that may be nobody's, and an unconfigured reader must say "cannot tell"
  // rather than quietly report on the wrong thing.
  miner: {
    active: process.env.FAUCET_MINER_ACTIVE === "true",
    heartbeatPath: process.env.FAUCET_MINER_HEARTBEAT_PATH ?? "",
  },

  /**
   * cTAZ, behind a flag and off by default (#322, #325).
   *
   * Their `requestfaucetdonation` pays a FIXED amount from the node's own mining wallet
   * and ignores whatever we ask for. `expectedZat` is our copy of that constant, and it
   * exists to be CHECKED rather than displayed on trust: the sender compares it against
   * what the node actually answered, so a change to their FAUCET_VALUE surfaces as drift
   * instead of leaving a stale promise on the page.
   */
  crosslink: {
    enabled: process.env.FAUCET_CTAZ_ENABLED === "true",
    rpcUrl: process.env.CROSSLINK_RPC_URL ?? "",
    // 0.5 cTAZ, their FAUCET_VALUE. Configurable only so the check can be exercised and
    // so an upstream change is a config edit rather than a code change.
    expectedZat: BigInt(Math.round(num("FAUCET_CTAZ_EXPECTED_ZAT", 50_000_000))),
    /**
     * cTAZ's own daily cap, in cTAZ, separate from FAUCET_DAILY_CAP_TAZ (#326).
     *
     * 25 is deliberately small, 50 drips a day at their fixed 0.5. The TAZ cap guards
     * OUR wallet, and we know how full it is. This one does not: the money comes out
     * of the Crosslink node's own mining wallet, we have no balance RPC to read it
     * with (their surface has none), and it is not our wallet to empty. So the number
     * is a courtesy budget on someone else's coins rather than a drain guard on ours,
     * and the honest default for a budget you cannot measure is a low one. Raise it
     * once a real cTAZ day has been observed, not before.
     */
    /** Where the box writes the node's state for the container to read (#322). Empty
     *  disables the file path and falls back to the RPC, which only works on a host. */
    statusFile: process.env.FAUCET_CTAZ_STATUS_FILE ?? "/app/data/ctaz-status.json",
    /**
     * THE ONLY WAY THE CONTAINER CAN REACH THE NODE (#409), and it defaults to on.
     *
     * A unix socket in the volume the container already mounts, served by a host-side
     * broker that allowlists four methods. The default is a path rather than empty
     * because the empty default on `rpcUrl` is what shipped a cTAZ toggle whose every
     * claim died at `fetch("")` while the panel said ready - a config value nobody set
     * because nobody knew it existed.
     *
     * Set FAUCET_CTAZ_RPC_SOCKET="" to turn it off, which is what a developer running
     * against a directly reachable node wants; rpcUrl then carries the call.
     */
    rpcSocket: process.env.FAUCET_CTAZ_RPC_SOCKET ?? "/app/data/ctaz-rpc.sock",
    /** 30s. The node's first request under mining was measured at 11.9 seconds, then
     *  milliseconds. A payment refused at 5s looks to a claimant like an empty wallet. */
    rpcTimeoutMs: num("FAUCET_CTAZ_RPC_TIMEOUT_MS", 30_000),
    get dailyCapZatoshi() {
      return tazToZatoshi(num("FAUCET_CTAZ_DAILY_CAP", 25));
    },
  },

  // Public address shown on /donate so people can refill the faucet. Unified,
  // so donations arrive shielded.
  donationAddress: process.env.FAUCET_DONATION_ADDRESS ?? "",
  // Transparent address the miner pays its coinbase to. Shown on /donate for
  // anyone who wants to point spare hashrate at us. Optional: unset just hides
  // that block, and it is a different address from the donation UA because a
  // coinbase cannot pay a shielded output directly.
  miningAddress: process.env.FAUCET_MINING_ADDRESS ?? "",
  // Who to contact about the service, shown on /terms. Deliberately config rather
  // than a constant: a fork must publish ITS operator, not ours, and a stale
  // address on a terms page is worse than an honest gap.
  contact: process.env.FAUCET_CONTACT ?? "",
  // The legal or trading name of whoever runs this deployment. Defaults to the
  // project's own operator; a fork sets its own.
  operator: process.env.FAUCET_OPERATOR ?? "Jino Labs",
  operatorUrl: process.env.FAUCET_OPERATOR_URL ?? "https://jinolabs.xyz",
  // MAINNET address for donations toward running the project. This is real ZEC,
  // on a site that is otherwise entirely testnet, which is the whole reason it is
  // validated rather than printed as given.
  //
  // Fails closed: anything that is not a mainnet unified address renders nothing
  // and says why in the log. A wrong address here does not degrade a feature, it
  // sends somebody's real money somewhere they cannot get it back from, so an
  // unset block is strictly better than a doubtful one. Deliberately NOT a boot
  // refusal like the numeric thresholds: a bad donation address must not take a
  // working faucet offline.
  maintenanceAddress: mainnetUnifiedOrEmpty(process.env.FAUCET_MAINTENANCE_ADDRESS ?? ""),

  // Ledger backend. "sqlite" = local file (dev / single box). "d1" = Cloudflare
  // D1 via the proxy Worker (survives Render's ephemeral disk). See worker/.
  dbBackend: (process.env.DB_BACKEND ?? "sqlite") as "sqlite" | "d1",
  d1ProxyUrl: process.env.D1_PROXY_URL ?? "",
  d1ProxySecret: process.env.D1_PROXY_SECRET ?? "",



  // Max sends waiting in the serial FIFO queue before we reject with "busy".
  sendQueueMaxPending: Math.max(1, Math.floor(num("SEND_QUEUE_MAX_PENDING", 20))),

  // Per-IP limit on /api/tx (#90). Each lookup costs a wallet RPC.
  //
  // The default is set from what our OWN page needs, not picked round: a visible
  // receipt polls every 10s, so 6/min per open tab. 60 leaves room for ten of
  // those behind one NAT, which a shared office or university exit needs, while
  // still stopping a scraper walking txids.
  txLookup: {
    windowSeconds: Math.max(1, Math.floor(num("TX_LOOKUP_RATE_WINDOW_SECONDS", 60))),
    max: Math.max(1, Math.floor(num("TX_LOOKUP_RATE_MAX", 60))),
  },
  // Backstop deadline for ONE queued task (#88). It bounds how long a caller
  // waits, not how long the wallet stays held: see queue.ts run().
  //
  // The default is derived from the sender's own timings so it always sits above
  // them. Setting this BELOW that (defaultTaskDeadlineMs, 309s with stock
  // zallet settings) makes legitimate slow sends report an unknown outcome,
  // which costs a claimant a full cooldown for coins they actually received.
  sendTaskDeadlineMs: Math.max(
    1000,
    Math.floor(num("SEND_TASK_DEADLINE_MS", defaultTaskDeadlineMs(zalletTimings))),
  ),
  // How long one queued send can really OCCUPY the queue: the sender's own worst case,
  // or the deadline if an operator raised that above it. The deadline is how long a
  // caller waits; the queue's tail advances on the send's real completion, which the
  // sender's timeouts bound. A deadline pinned BELOW the sender (the API harness does
  // this on purpose) must not shrink anything that has to cover the queue, which is the
  // pending-claim lease: review found a 60 s deadline gave a 22-minute lease against a
  // 93-minute real wait (risk register #8).
  get sendResidenceMs(): number {
    return Math.max(this.sendTaskDeadlineMs, senderWorstCaseMs(zalletTimings));
  },

  turnstile: {
    siteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
    secretKey: (process.env.TURNSTILE_SECRET_KEY ?? "").trim(),
    get enabled() {
      return this.secretKey.length > 0;
    },
  },

  // Anti-abuse gate before a claim: "pow" (browser proof-of-work / hashcash),
  // or "none". ("turnstile" parses and refuses to serve: see assertServingConfig.)
  //
  // The fallback is POW, not none, and that is the whole point. This is the only
  // switch that makes a claim COST anything, and its default used to be off: a
  // fresh box, a clean redeploy, or a forgotten variable all came up serving with
  // no gate at all, silently. The live faucet had pow only because somebody had
  // typed it into the box by hand, which is not a control, it is a habit.
  //
  // A security default of "off" eventually ships off. So an operator who says
  // nothing gets the gate, and turning it OFF is the thing you have to ask for by
  // name (challenge=none, which local dev and the test doubles do explicitly).
  //
  // Consequence worth knowing: in production with pow, saltGuard refuses to boot
  // on an empty or placeholder RATE_LIMIT_SALT, because a known salt makes the
  // challenge forgeable. So a fresh box now stops with a message naming what to
  // set, instead of coming up unprotected. That is the trade, and it is the right
  // way round: loud and safe over quiet and open.
  challenge: challengeFromEnv(),

  pow: {
    // Base difficulty in leading zero bits of sha256(challenge:nonce). ~20 bits
    // is a couple seconds on a laptop, more on a phone - modest on purpose so a
    // first-time real user barely waits. Repeat claims escalate above this.
    baseBits: Math.max(8, Math.min(28, Math.floor(num("FAUCET_POW_BITS", 20)))),
    // Each recent claim from the same client adds this many bits (quadratic cost
    // for anyone hammering the faucet, unnoticeable for a one-off human).
    escalateBits: Math.max(0, Math.floor(num("FAUCET_POW_ESCALATE_BITS", 2))),
    // Hard cap so difficulty can't run away into a device-killing wait.
    maxBits: Math.max(12, Math.min(30, Math.floor(num("FAUCET_POW_MAX_BITS", 26)))),
    // How long a signed challenge is valid before the browser has to fetch a new one.
    //
    // Raised from 180 to 600, and it is the lever powBudget.ts names for making the
    // gate harder: the solvable ceiling is a function of this, so a longer life buys
    // escalation HEADROOM rather than charging everyone more. 180s put the ceiling at
    // 23 bits, giving a repeat offender 3 bits (8x base work) before clamping. 600s
    // puts it at 25, giving 5 bits (32x). A first-time claimer is unaffected: they
    // still solve the base 20 bits, in about 10s on the slow phone we design for.
    //
    // What it costs, stated because it is a real tradeoff rather than free. A
    // longer-lived challenge is a bigger window to stockpile cheap challenges during
    // a quiet minute and spend them later, dodging the global pressure surcharge. It
    // is worth very little: a challenge is single-use (its signature is spent into
    // used_challenges) and bound to the issuing ipHash, and the per-IP cooldown caps
    // that IP at one drip a day regardless. So a stockpile buys at most one drip per
    // IP, which is what the farmer already had.
    ttlSeconds: Math.max(30, Math.floor(num("FAUCET_POW_TTL_SECONDS", 600))),
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
/**
 * Checks that only make sense for a process about to SERVE traffic. Called from
 * instrumentation.register() at boot, never at import.
 *
 * The salt guard used to run at import time, which meant `next build` demanded the
 * production secret: it sets NODE_ENV=production and imports every route module to
 * collect page data, so compiling the artifact required a runtime secret. A build
 * serves nothing and has no gate to forge yet. register() does not run during a
 * build, so boot is where this belongs.
 *
 * The security property is unchanged: a real server still refuses to start without
 * a usable salt, and it says so in a boot log where an operator can act on it
 * rather than buried in build output (#206).
 */
export function assertServingConfig(): void {
  const saltProblem = saltRejectionReason({
    salt: process.env.RATE_LIMIT_SALT ?? "",
    production: process.env.NODE_ENV === "production",
    challenge: config.challenge,
  });
  if (saltProblem) throw new Error(saltProblem);
  // TURNSTILE IS NOT A MODE THIS FAUCET CAN SERVE. A server-side verifier exists
  // (src/lib/turnstile.ts, fails closed, with a timeout) and no client half does: the page
  // renders no Turnstile widget and the claim body carries no token, so with or without a
  // secret every claim was a 403. The project's position is no captcha vendor
  // (docs/ARCHITECTURE.md, PRIVACY.md) and no client half is planned; asking for the mode
  // by name refuses to boot, where the operator is reading, instead of serving nobody one
  // 403 at a time.
  if (config.challenge === "turnstile") {
    throw new Error(
      "FAUCET_CHALLENGE=turnstile is not a mode this faucet can serve: the page renders no Turnstile widget " +
        "and sends no token, so every claim would be refused (with or without TURNSTILE_SECRET_KEY). " +
        "Run pow (the default, no keys needed) or none.",
    );
  }
  // A Turnstile key on a pow or none box is ignored, and says so once: it used to flip the
  // mode on its own, and an operator who set it for that reason should learn here that it
  // no longer does anything.
  if (config.turnstile.enabled) {
    console.warn(`[config] TURNSTILE_SECRET_KEY is set and IGNORED: the gate is ${config.challenge}, and turnstile is not a mode this faucet can serve`);
  }
  // A gate that is OFF says so where the operator is reading. FAUCET_CHALLENGE=none is a
  // legitimate choice for local work and the integration stacks; on a production box it
  // is an ungated faucet holding real testnet funds, and a .env.local copied from a dev
  // template is exactly how one arrives there without anyone deciding it.
  if (config.challenge === "none" && process.env.NODE_ENV === "production") {
    console.warn("[config] THE ANTI-ABUSE GATE IS OFF (FAUCET_CHALLENGE=none) in production: every claim is accepted without proof of work. If this is not a decision you made, set FAUCET_CHALLENGE=pow.");
  }
}
