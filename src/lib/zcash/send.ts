/**
 * Send adapter: turns "pay `amountZat` to `toAddress`" into a broadcast txid,
 * and exposes the faucet wallet's spendable balance so the API can guard against
 * draining the single hot wallet.
 *
 * Two implementations behind one interface:
 *
 *   MockSender  (FAUCET_SENDER=mock, default)
 *     Runs with no keys and no node. Keeps a simulated balance (seeded from
 *     FAUCET_MOCK_BALANCE_TAZ) that decrements per send, so the low-balance
 *     guard, the "faucet empty" UX, and the whole flow are testable end to end.
 *
 *   RealSender  (FAUCET_SENDER=real, see ./realsend.ts)
 *     Spends the faucet's funded transparent testnet wallet: fetch UTXOs, build
 *     + sign a real Zcash tx (@bitgo/utxo-lib), broadcast via lightwalletd.
 *
 * The interface is intentionally minimal so a third backend (e.g. a Zallet RPC
 * over the Z3 stack, for shielded sends) can drop in later.
 */
import { config } from "../config";
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

export interface Sender {
  readonly name: string;
  /** Spendable balance of the single faucet wallet, in zatoshi. */
  balance(): Promise<bigint>;
  send(req: SendRequest): Promise<SendResult>;
}

/** Testnet block explorer link for a txid (best-effort convenience). */
function explorerUrl(txid: string): string {
  return `https://blockexplorer.one/zcash/testnet/tx/${txid}`;
}

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
    return { txid, explorerUrl: explorerUrl(txid) };
  }
}

let cached: Sender | null = null;

export function getSender(): Sender {
  if (cached) return cached;
  if (config.sender === "real") {
    // Lazy require so the real sender's heavy deps only load when configured.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RealSender } = require("./realsend");
    cached = new RealSender();
  } else {
    cached = new MockSender();
  }
  return cached!;
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
