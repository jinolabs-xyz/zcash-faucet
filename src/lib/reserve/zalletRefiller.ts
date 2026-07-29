/**
 * Zallet refill step: shield mature transparent coinbase into the faucet's
 * Orchard account (z_shieldcoinbase), then wait for the operation to land.
 * Mining runs in its own container at cutover; this is only the shield leg.
 *
 * Concurrency note, because it's the whole point: this step spends transparent
 * coinbase UTXOs, drips spend Orchard notes — disjoint input sets, so it can
 * never select a note a live send is spending. It still runs through the send
 * queue (the reconciler enqueues it) so the wallet builds one tx at a time and
 * proving CPU isn't contended.
 *
 * Not exercised until cutover (needs a synced node and a mining address with
 * mature coinbase). Kept deliberately self-contained: its own RPC round-trip
 * rather than a refactor of zalletsend.ts, to keep this slice reviewable.
 */
// .ts extension for node --test resolution, same pattern as pow.ts.
import { config } from "../config.ts";
import type { Refiller, StepOutcome } from "./refiller";
import { getNodeStatus } from "../zcash/nodeStatus.ts";
import { mayShield, readShieldFreshness } from "../zcash/shieldGate.ts";

// Cap coinbase UTXOs per shield tx (zcashd's old default). A long mining
// backlog gets swept over several steps instead of one oversized tx, and it
// keeps each queue-held step bounded so drips never wait long.
const SHIELD_UTXO_LIMIT = 50;

interface RpcError {
  code: number;
  message: string;
}
interface OperationResult {
  id: string;
  status: "queued" | "executing" | "success" | "failed" | "cancelled";
  error?: RpcError;
}

export class ZalletRefiller implements Refiller {
  readonly name = "zallet-shield";

  private get z() {
    return config.zallet;
  }

  private async rpc<T>(method: string, paramsJson: string): Promise<T> {
    const { endpoint, user, password } = this.z;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (user) {
      headers.authorization = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
    }
    const body = `{"jsonrpc":"2.0","id":"refill","method":${JSON.stringify(method)},"params":${paramsJson}}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.z.rpcTimeoutMs),
    });
    if (!res.ok) throw new Error(`zallet RPC ${method} HTTP ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { result?: T; error?: RpcError | null };
    if (json.error) throw new Error(`zallet RPC ${method}: ${json.error.message} (code ${json.error.code})`);
    return json.result as T;
  }

  async step(): Promise<StepOutcome> {
    const { account, address } = this.z;
    if (!account) throw new Error("ZALLET_ACCOUNT (account UUID) is required to shield coinbase.");
    if (!address) throw new Error("ZALLET_ADDRESS is required to shield coinbase.");

    // THE GATE. This is the broadcast site, so this is where the refusal has to
    // live: shieldGate.ts decides nothing until something declines to call the
    // RPC, and a gate nobody calls is the same as a gate nobody deployed (#171).
    //
    // Fails CLOSED on purpose. mayShield() is true only for "safe", so both
    // "unsafe" and "unverifiable" stop us here. Never write `state !== "unsafe"`,
    // which is the one phrasing that lets an unverifiable node broadcast.
    //
    // Reading our height from getwalletstatus rather than a separate zebra call
    // is deliberate: it is the height the WALLET believes, and the wallet is what
    // stamps expiry_height onto the transaction. A zebra reading could be correct
    // while the wallet's view is stale, and it is the wallet's view that kills a
    // shield (#172: expiry already mined four seconds before the build).
    //
    // Reuse the gate getNodeStatus already computed instead of re-deriving it, so
    // what /api/status shows an operator is the same verdict that allowed or
    // refused the broadcast. Two independent readings of one oracle drift apart
    // between calls and then the dashboard alibis a decision it never made.
    // A null status is the wallet being unreachable, which is unverifiable, not
    // a pass: readShieldFreshness(null) is what says so.
    const status = await getNodeStatus();
    const gate = status?.shield ?? readShieldFreshness(null);
    if (!mayShield(gate)) {
      return { moved: false, refused: { state: gate.state, reason: gate.reason, lag: gate.lag } };
    }

    // z_shieldcoinbase <account-uuid> <toaddress> <fee=null> <limit> — sweep
    // mature coinbase from the account's transparent receivers into the faucet
    // UA. This zallet rejects zcashd's "*" wildcard on purpose (it would link
    // unrelated accounts on-chain), so we scope by our account UUID; the
    // privacy policy then defaults to AllowLinkingAccountAddresses, the only
    // one valid for a UUID sweep. Fee must be null (always ZIP 317).
    //
    // No opid means nothing was shieldable this tick. That is NOT necessarily
    // "the miner hasn't produced anything" — it reads identically when the
    // coinbase exists but belongs to receivers outside this account, or is not
    // yet mature. #172 is what that ambiguity cost, so return remainingUTXOs
    // instead of discarding it and let the reconciler decide when a run of
    // empty sweeps has stopped being normal.
    const op = await this.rpc<{ opid?: string; remainingUTXOs?: number }>(
      "z_shieldcoinbase",
      `[${JSON.stringify(account)},${JSON.stringify(address)},null,${SHIELD_UTXO_LIMIT}]`,
    );
    if (!op?.opid) return { moved: false, remainingUTXOs: op?.remainingUTXOs };
    await this.awaitOperation(op.opid);
    return { moved: true, remainingUTXOs: op.remainingUTXOs };
  }

  private async awaitOperation(opid: string): Promise<void> {
    const deadline = Date.now() + this.z.opTimeoutMs;
    const idJson = `[[${JSON.stringify(opid)}]]`;
    for (;;) {
      const [status] = await this.rpc<OperationResult[]>("z_getoperationstatus", idJson);
      if (status && status.status !== "queued" && status.status !== "executing") break;
      if (Date.now() > deadline) {
        throw new Error(`zallet shield ${opid} timed out (still ${status?.status ?? "pending"}).`);
      }
      await new Promise((r) => setTimeout(r, this.z.pollMs));
    }
    const [done] = await this.rpc<OperationResult[]>("z_getoperationresult", idJson);
    if (!done || done.status !== "success") {
      throw new Error(`zallet shield failed: ${done?.error?.message ?? done?.status ?? "unknown error"}`);
    }
  }
}
