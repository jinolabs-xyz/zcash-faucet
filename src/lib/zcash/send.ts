/**
 * Send adapter: turns "pay `amountZat` to `toAddress`" into a broadcast txid,
 * and exposes the faucet wallet's spendable balance so the API can guard against
 * draining the single hot wallet.
 *
 * Two implementations behind one interface:
 *
 *   MockSender  (default, FAUCET_SENDER=mock)
 *     Runs with no keys and no node. Keeps a simulated balance (seeded from
 *     FAUCET_MOCK_BALANCE_TAZ) that decrements per send, so the low-balance
 *     guard, the "faucet empty" UX, and the whole flow are testable end to end.
 *
 *   WebzjsSender (FAUCET_SENDER=webzjs)
 *     Real path. Uses a WASM light-wallet (Zcash Foundation's WebZjs /
 *     zcash_client_backend compiled to WASM) that talks to a reachable
 *     lightwalletd endpoint (with failover) to scan the ONE funded faucet
 *     wallet, read its spendable balance, build a shielded spend, prove, and
 *     broadcast. Wire the marked TODOs.
 *
 * The interface is intentionally minimal so a third backend (e.g. a private
 * zallet RPC over the Z3 docker-compose stack) can drop in later.
 */
import { config } from "../config";
import { resolveEndpoint } from "./lightwalletd";
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

class WebzjsSender implements Sender {
  readonly name = "webzjs";

  private requireSeed(): string {
    if (!config.walletSeed) {
      throw new Error("FAUCET_WALLET_SEED is required when FAUCET_SENDER=webzjs.");
    }
    return config.walletSeed;
  }

  async balance(): Promise<bigint> {
    this.requireSeed();
    const endpoint = await resolveEndpoint();
    if (!endpoint) throw new Error("No reachable lightwalletd endpoint.");
    // ─── Real integration outline ─────────────────────────────────────────
    //   const wallet = await WebWallet.new("test", endpoint, 1);
    //   const acct   = await wallet.create_account_from_seed(config.walletSeed);
    //   await wallet.sync();
    //   return BigInt(await wallet.spendable_balance(acct));   // zatoshi
    throw new Error("WebzjsSender.balance() not wired yet. See README → Going live.");
  }

  async send(req: SendRequest): Promise<SendResult> {
    this.requireSeed();
    const endpoint = await resolveEndpoint();
    if (!endpoint) throw new Error("No reachable lightwalletd endpoint.");

    // Recipient can be shielded (unified / Sapling) or transparent — both are
    // supported. The wallet routes funds by the destination address:
    //   • shielded  → shielded-to-shielded spend (fully private)
    //   • transparent → a "deshielding" spend; funds leave the shielded pool and
    //     land in a PUBLIC transparent output. Allowed, just not private.
    const recipientIsShielded = req.addressInfo.shielded === true;
    void recipientIsShielded; // (wire pool selection / policy here if desired)

    // ─── Real integration outline (see README "Going live") ───────────────
    // 1. const wallet = await WebWallet.new("test", endpoint, 1);
    //    const acct   = await wallet.create_account_from_seed(config.walletSeed);
    // 2. await wallet.sync();                       // catch up the faucet's notes
    // 3. Optionally re-check spendable >= req.amountZat and throw a clear error.
    // 4. propose_transfer accepts unified, Sapling, AND transparent addresses;
    //    it builds a shielded->transparent (deshielding) tx automatically when
    //    the recipient is a t-address.
    //    const proposal = await wallet.propose_transfer(acct, req.toAddress, req.amountZat);
    //    const txids    = await wallet.create_proposed_transactions(proposal, config.walletSeed);
    //    const txid     = txids[0];
    //    return { txid, explorerUrl: explorerUrl(txid) };
    //
    // Keep this server-side only — the seed must never reach the browser.
    throw new Error(
      "WebzjsSender.send() is not wired yet. Implement the WASM wallet flow in send.ts, " +
        "or run FAUCET_SENDER=mock for a working demo. See README → Going live.",
    );
  }
}

let cached: Sender | null = null;

export function getSender(): Sender {
  if (cached) return cached;
  cached = config.sender === "webzjs" ? new WebzjsSender() : new MockSender();
  return cached;
}

/**
 * Read the faucet balance safely for guards/status. If the backend can't report
 * a balance yet (e.g. real sender not wired), returns null = "unknown" rather
 * than throwing, so an unimplemented balance never blocks the app from loading.
 */
export async function safeBalance(): Promise<bigint | null> {
  try {
    return await getSender().balance();
  } catch {
    return null;
  }
}
