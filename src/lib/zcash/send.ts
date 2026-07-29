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
import type { AddressInfo } from "./address";

export interface SendRequest {
  toAddress: string;
  addressInfo: AddressInfo;
  amountZat: bigint;
}

export interface SendResult {
  txid: string;
  explorerUrl?: string;
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

export async function safeDonations(): Promise<DonationTally | null> {
  if (config.sender !== "zallet") return null;
  const now = Date.now();
  if (donationCache && now - donationCache.at < DONATION_CACHE_MS) return donationCache.value;

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
  donationCache = { at: now, value };
  return value;
}

/** Test seam: the cache is module state and would leak between cases. */
export function resetDonationCache(): void {
  donationCache = null;
}
