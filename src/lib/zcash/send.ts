/**
 * Send adapter: turns "pay `amountZat` to `toAddress`" into a broadcast txid,
 * and exposes the faucet wallet's spendable balance so the API can guard against
 * draining the single hot wallet.
 *
 * Three implementations behind one interface:
 *
 *   MockSender  (FAUCET_SENDER=mock, default)
 *     Runs with no keys and no node. Keeps a simulated balance (seeded from
 *     FAUCET_MOCK_BALANCE_TAZ) that decrements per send, so the low-balance
 *     guard, the "faucet empty" UX, and the whole flow are testable end to end.
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

import { explorerTxUrl } from "./explorer.ts";

class MockSender implements Sender {
  readonly name = "mock";

  // Persist the simulated balance across dev hot-reloads.
  private get store() {
    const g = globalThis as unknown as { __faucetMockBal?: bigint };
    if (g.__faucetMockBal === undefined) g.__faucetMockBal = config.mockBalanceZatoshi;
    return g as { __faucetMockBal: bigint };
  }

  async balance(): Promise<bigint> {
    return this.store.__faucetMockBal;
  }

  async send(req: SendRequest): Promise<SendResult> {
    // Guard is enforced upstream, but double-check so mock can never go negative.
    if (this.store.__faucetMockBal < req.amountZat) {
      throw new Error("Insufficient faucet balance (mock).");
    }
    const seed = `${req.toAddress}:${req.amountZat}:${Date.now()}`;
    let h = 0n;
    for (const ch of seed) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 256n);
    const txid = h.toString(16).padStart(64, "0").slice(0, 64);
    await new Promise((r) => setTimeout(r, 300)); // simulate broadcast latency
    this.store.__faucetMockBal -= req.amountZat;
    return { txid, explorerUrl: explorerTxUrl(txid) };
  }
}

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (this._real ??= new (require("./realsend").RealSender)());
  }
  private t2z() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (this._t2z ??= new (require("./t2zsend").T2zSender)());
  }

  balance(): Promise<bigint> {
    return this.real().balance(); // both spend the same transparent wallet
  }

  send(req: SendRequest): Promise<SendResult> {
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

/**
 * Add funds to the simulated mock balance. Only the mock refiller uses this,
 * so the reserve loop is testable end to end without a node. Throws in any
 * other mode rather than silently pretending funds arrived.
 */
export function creditMockBalance(zat: bigint): void {
  // Config check, not instanceof: constructing the sender just to inspect its
  // type would drag in the zallet/real modules as a side effect.
  if (config.sender !== "mock") {
    throw new Error(`creditMockBalance is mock-only (sender is "${config.sender}").`);
  }
  const g = globalThis as unknown as { __faucetMockBal?: bigint };
  g.__faucetMockBal = (g.__faucetMockBal ?? config.mockBalanceZatoshi) + zat;
}

let cached: Sender | null = null;

export function getSender(): Sender {
  if (cached) return cached;
  let s: Sender;
  if (config.sender === "zallet") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    s = new (require("./zalletsend").ZalletSender)() as Sender;
  } else if (config.sender === "real") {
    s = new CompositeRealSender();
  } else {
    s = new MockSender();
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
