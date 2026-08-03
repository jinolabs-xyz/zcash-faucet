/**
 * Send adapter: turns "pay `amountZat` to `toAddress`" into a broadcast txid,
 * and exposes the faucet wallet's spendable balance so the API can guard against
 * draining the single hot wallet.
 *
 * Two implementations behind one interface. Tests point the zallet one at
 * scripts/fake-zallet.mjs, so the code under test is the production path:
 *
 *   RealSender  (FAUCET_SENDER=real, see ./realsend.ts + ./t2zsend.ts)
 *     Spends the faucet's funded *transparent* testnet wallet. Transparent
 *     recipients get a plain Zcash tx (@bitgo/utxo-lib); unified recipients get
 *     a transparent→Orchard t2z bridge tx. Balance and drip origins are public.
 *
 *   ZalletSender  (FAUCET_SENDER=zallet, see ./zalletsend.ts)
 *     A genuinely shielded faucet: holds Orchard notes and pays z→z via a running
 *     Zallet wallet (Z3 stack) over JSON-RPC. Faucet holdings and the faucet↔
 *     claimant link stay private, and it can pay Sapling recipients too.
 */
// .ts extension for node --test resolution, same pattern as pow.ts.
import { config } from "../config.ts";
import type { FaucetNetwork } from "../network.ts";
import type { AddressInfo } from "./address";

export interface SendRequest {
  toAddress: string;
  addressInfo: AddressInfo;
  amountZat: bigint;
}

/**
 * WHEN THE DATA IS MISSING, THE TYPE WIDENS. THE DATA IS NEVER MANUFACTURED.
 *
 * `txid` is optional because Crosslink's faucet primitive answers with an amount and no
 * transaction id at all, so a cTAZ send genuinely has none to report. Every other sender
 * returns one, and `finalizeClaim` refuses a sent claim without one unless the caller
 * names the network as having none, so this widening does not weaken the TAZ path.
 *
 * The alternative was a placeholder, and that is the same mistake as `balance ?? 0` and
 * the ledger's old `txid ?? ""`: both converted an absence into a value at the boundary
 * and left nothing downstream able to recover it.
 *
 * `amountZat` is here because their reply is the only authoritative statement of what was
 * paid. Their amount is fixed and ignores what we asked for, so the receipt renders what
 * the network answered rather than what we requested.
 */
export interface SendResult {
  txid?: string;
  explorerUrl?: string;
  amountZat?: bigint;
}

/**
 * Thrown when a send was SUBMITTED but we lost track of how it ended. An opid
 * exists, so the wallet may broadcast (or already has). The caller must not
 * claim nothing moved and must not release the claimant's cooldown, or the
 * faucet can pay twice for one entitlement.
 */
export class SendOutcomeUnknownError extends Error {
  readonly opid: string;

  constructor(opid: string, cause: string) {
    super(`zallet send ${opid} outcome unknown: ${cause}`);
    this.name = "SendOutcomeUnknownError";
    this.opid = opid;
  }
}

export interface Sender {
  readonly name: string;
  /** Spendable balance of the single faucet wallet, in zatoshi. */
  balance(): Promise<bigint>;
  send(req: SendRequest): Promise<SendResult>;
}

import { createRequire } from "node:module";
import { ZalletSender } from "./zalletsend.ts";
import type { DonationTally } from "./donations.ts";

// The transparent backends load lazily because they drag in utxo-lib and the
// t2z prover. createRequire because a bare require() does not exist in ESM.
const req = createRequire(import.meta.url);

/**
 * Real mode routes by recipient type: transparent (`tm…`) → RealSender (a plain
 * Zcash tx), unified (`utest1…`, Orchard) → T2zSender (transparent→shielded).
 * Sapling-only (`ztestsapling1…`) isn't payable via t2z (Orchard outputs only),
 * so it's refused with a clear message. Balance is the same transparent wallet
 * either way.
 */
class CompositeRealSender implements Sender {
  readonly name = "real";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _real: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _t2z: any;

  private real() {
    return (this._real ??= new (req("./realsend").RealSender)());
  }
  private t2z() {
    return (this._t2z ??= new (req("./t2zsend").T2zSender)());
  }

  balance(): Promise<bigint> {
    return this.real().balance(); // both spend the same transparent wallet
  }

  // async, not a bare throw: the Sender contract promises a Promise, and a
  // synchronous throw from something declared async surprises any caller that
  // reaches for .catch() instead of try/catch.
  async send(req: SendRequest): Promise<SendResult> {
    const kind = req.addressInfo.kind;
    if (kind === "unified") return this.t2z().send(req);
    if (kind === "sapling") {
      throw new Error(
        "Sapling-only addresses (ztestsapling1…) aren't supported. Use a unified " +
          "shielded address (utest1…) or a transparent one (tm…).",
      );
    }
    return this.real().send(req); // transparent
  }
}

let cached: Sender | null = null;
let cachedCrosslink: Sender | null = null;

export function getSender(): Sender {
  if (cached) return cached;
  let s: Sender;
  if (config.sender === "zallet") {
    s = new ZalletSender();
  } else {
    s = new CompositeRealSender();
  }
  cached = s;
  return s;
}

/**
 * The sender for a given network (#326).
 *
 * TAZ goes wherever FAUCET_SENDER points, exactly as it always has. cTAZ goes to
 * Crosslink and nowhere else, because "cTAZ" IS the Crosslink node's faucet primitive:
 * there is no other thing that pays it, so this is not a routing choice, it is what
 * the word means.
 *
 * THROWS RATHER THAN FALLING BACK when cTAZ is off. A fallback here would send a
 * request for one chain's coins to the sender for another, which is the single worst
 * thing a router can do with money, and the flag being off is a deployment fact rather
 * than a transient one, so there is nothing to retry into.
 *
 * Loaded through require for the same reason the transparent backends are: cTAZ is off
 * by default, and an unconditional import would pull the module into every deploy that
 * will never call it.
 */
export function getSenderFor(network: FaucetNetwork): Sender {
  if (network !== "ctaz") return getSender();
  if (!config.crosslink.enabled) {
    throw new Error("cTAZ is not enabled on this deployment (FAUCET_CTAZ_ENABLED).");
  }
  return (cachedCrosslink ??= new (req("./crosslinksend").CrosslinkSender)());
}

/**
 * Read the faucet balance safely for guards/status. If the backend can't report
 * a balance (e.g. real mode but the endpoint is down), returns null = "unknown"
 * rather than throwing, so status/guards never hard-fail the app.
 */
export async function safeBalance(): Promise<bigint | null> {
  try {
    return await getSender().balance();
  } catch {
    return null;
  }
}

/**
 * Donations for display (#192). Null means "we cannot say", which the page renders
 * as nothing at all rather than as a zero: a wallet we cannot reach has not told us
 * that nobody donated.
 *
 * Cached because /donate is a server component, so without this every visitor costs
 * a paged walk of the whole account history. Two minutes stale is invisible on a
 * cumulative total and it caps the wallet load at one scan regardless of traffic.
 *
 * Only zallet can answer this. The transparent senders spend a wallet whose
 * receipts we do not enumerate, and there is no account to attribute against.
 */
const DONATION_CACHE_MS = 120_000;
let donationCache: { at: number; value: DonationTally | null } | null = null;
/** Single-flight guard for the background refresh. */
let donationRefresh: Promise<void> | null = null;
/** Bumped by resetDonationCache. A refresh publishes only into the epoch it was
 * started in, so an orphaned in-flight scan from before a reset cannot land late
 * and clobber the cache with older data. A stale write winning is the class this
 * removes; the test suite found it as a cross-test clobber, and "only reachable
 * via reset today" is how such things stay latent until they are not. */
let donationEpoch = 0;

/**
 * NEVER BLOCKS THE PAGE. The tally is a full wallet-history scan, measured at
 * ~9 seconds cold on production, and the old shape made the first visitor after
 * every 2-minute cache expiry pay that scan inline in /donate's server render.
 * A 9-second money page because a display-only counter wanted freshness is the
 * wrong trade in both directions.
 *
 * Now: whatever is cached is returned immediately, stale included, and expiry
 * kicks off ONE background refresh for future requests instead of taxing the
 * present one. The only render that sees null for freshness reasons is the very
 * first after boot, where the page simply omits the counter, which it already
 * does whenever the tally is unavailable. Staleness is bounded by cache age plus
 * one scan, against a counter that only ever grows slowly.
 *
 * The refresh guard clears on completion AND rejection, the #324 poisoned-seed
 * lesson: a cached rejected promise would freeze the counter at its last value
 * forever with nothing left to retry.
 */
export async function safeDonations(): Promise<DonationTally | null> {
  if (config.sender !== "zallet") return null;
  const now = Date.now();
  const fresh = donationCache !== null && now - donationCache.at < DONATION_CACHE_MS;

  if (!fresh) {
    const epoch = donationEpoch;
    donationRefresh ??= (async () => {
      let value: DonationTally | null = null;
      try {
        const { tally, complete } = await (getSender() as ZalletSender).donations();
        // A partial scan of a cumulative total is wrong, not small, so publish nothing.
        value = complete ? tally : null;
      } catch (e) {
        // Display-only, so this fails OPEN: /donate is the page that still matters when
        // the faucet is dry, and it must not 500 because a counter could not load.
        console.warn(`[donations] tally unavailable, hiding the counter: ${(e as Error).message}`);
      }
      if (epoch === donationEpoch) donationCache = { at: Date.now(), value };
    })().finally(() => {
      if (epoch === donationEpoch) donationRefresh = null;
    });
  }

  return donationCache?.value ?? null;
}

/** Test seam: the cache is module state and would leak between cases. */
export function resetDonationCache(): void {
  donationEpoch += 1;
  donationCache = null;
  // The guard resets too, or a refresh started by one caller would swallow the
  // next caller's expiry; and the epoch bump above orphans that old refresh so
  // its late result cannot publish into the new world.
  donationRefresh = null;
}
