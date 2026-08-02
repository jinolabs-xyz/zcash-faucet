/**
 * The cTAZ sender: our operational layer in front of Crosslink's payout primitive.
 *
 * v1 builds no send path (#322). Their `requestfaucetdonation` moves the money from the
 * node's own mining wallet; we decide whether it should, which is the same division of
 * labour the TAZ side has with Zallet. Everything their primitive lacks, cooldowns, caps,
 * IP limits, a readiness gate, accounting, is ours and already exists.
 *
 * Two things about their contract shape the code more than anything else, both observed
 * in the spike rather than read from a doc:
 *
 *   PARAMS ARE A STRUCT. `[{"address": "..."}]`, not `["..."]`. A bare string returns
 *   Invalid params, which cost the spike two calls and read like their validator
 *   rejecting a good address. The double refuses the bare form so we cannot regress it.
 *
 *   THE REPLY HAS NO TXID. `{"amount": 50000000}` and nothing else, so there is no
 *   transaction id to record, no explorer to link, and nothing to copy. The ledger stores
 *   NULL through the one exemption that exists for it, and the receipt says so.
 */
import { config } from "../config.ts";
import type { Sender, SendRequest, SendResult } from "./send.ts";

/** Their fixed FAUCET_VALUE arrives here to be CHECKED, never to be displayed on trust. */
export class CrosslinkAmountDrift extends Error {
  // Plain fields, not parameter properties: `node --test` strips types rather than
  // compiling them, and a parameter property is syntax it cannot strip. tsc accepts it
  // and the runtime does not, which is a gap worth knowing about in this repo.
  readonly expected: bigint;
  readonly actual: bigint;

  constructor(expected: bigint, actual: bigint) {
    super(
      `crosslink paid ${actual} zatoshi, we expected ${expected}. Their FAUCET_VALUE is a ` +
        "constant in their wallet code, so a change to it is theirs and not ours. The claim " +
        "was PAID at the amount above.",
    );
    this.name = "CrosslinkAmountDrift";
    this.expected = expected;
    this.actual = actual;
  }
}

interface RpcReply {
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class CrosslinkSender implements Sender {
  readonly name = "crosslink";

  private readonly rpcUrl: string;
  private readonly expectedZat: bigint;

  // Both injected, defaulting to config. The expectation especially: reading it straight
  // from `config` at call time made the drift case untestable, because config resolves its
  // env once at ITS module load and no amount of setting the variable afterwards changes
  // it. Injecting is also the honest shape, since the expectation is a fact about THEIR
  // constant rather than about this class.
  constructor(rpcUrl: string = config.crosslink.rpcUrl, expectedZat: bigint = config.crosslink.expectedZat) {
    this.rpcUrl = rpcUrl;
    this.expectedZat = expectedZat;
  }

  private async rpc(method: string, params: unknown[]): Promise<RpcReply> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`crosslink rpc ${method}: HTTP ${res.status}`);
    return (await res.json()) as RpcReply;
  }

  /**
   * There is no balance RPC on their surface. The CTO read all fifty methods in their
   * zebra-rpc: the only balance-shaped ones are the transparent address index, which
   * cannot see an Orchard wallet's shielded funds.
   *
   * So this throws rather than returning a number, and `safeBalance` turns that into
   * null, which the panel renders as unknown. Returning 0n would be the `balance ?? 0`
   * bug volunteered rather than inherited: an unreadable balance is not an empty one.
   *
   * The upgrade path, noted on #322 and not v1: `get_wallet_ufvk` hands over the wallet's
   * VIEWING key, so a watch-only reader could compute the real figure with no spend key
   * involved.
   */
  async balance(): Promise<bigint> {
    throw new Error(
      "crosslink exposes no balance RPC, so the cTAZ wallet balance is unknown rather than zero",
    );
  }

  async send(req: SendRequest): Promise<SendResult> {
    // The struct form. Written as an object literal rather than assembled, so the shape
    // is visible at a glance and a future edit cannot quietly flatten it to a string.
    const reply = await this.rpc("requestfaucetdonation", [{ address: req.toAddress }]);

    if (reply.error) {
      const msg = reply.error.message ?? "unknown error";
      // Their queue is 16 deep and one at a time, and it refuses an address whose previous
      // request is still pending. Both surface as the same message, and both mean try
      // later rather than something is broken.
      if (/too busy/i.test(msg)) throw new Error(`crosslink faucet is busy: ${msg}`);
      throw new Error(`crosslink rpc requestfaucetdonation: ${msg}`);
    }

    const amount = (reply.result as { amount?: unknown } | undefined)?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new Error(
        `crosslink replied without a usable amount: ${JSON.stringify(reply.result)}. ` +
          "Their reply is the only evidence a donation happened, so an unreadable one is " +
          "an unknown outcome rather than a success.",
      );
    }

    // THE DRIFT CHECK. Their amount is fixed and ignores what we asked for, so this is
    // the only authoritative number. Comparing it against our copy of their constant
    // means an upstream change surfaces here instead of leaving the page promising an
    // amount the network no longer pays.
    const paid = BigInt(amount);
    if (paid !== this.expectedZat) throw new CrosslinkAmountDrift(this.expectedZat, paid);

    // No txid exists to return. SendResult.txid is optional for exactly this network, and
    // the receipt says the network returns none rather than showing a blank.
    return { amountZat: paid };
  }
}
