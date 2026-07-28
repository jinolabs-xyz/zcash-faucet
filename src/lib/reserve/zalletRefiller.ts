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
import type { Refiller } from "./refiller";

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

  async step(): Promise<void> {
    const { account, address } = this.z;
    if (!account) throw new Error("ZALLET_ACCOUNT (account UUID) is required to shield coinbase.");
    if (!address) throw new Error("ZALLET_ADDRESS is required to shield coinbase.");

    // z_shieldcoinbase <account-uuid> <toaddress> <fee=null> <limit> — sweep
    // mature coinbase from the account's transparent receivers into the faucet
    // UA. This zallet rejects zcashd's "*" wildcard on purpose (it would link
    // unrelated accounts on-chain), so we scope by our account UUID; the
    // privacy policy then defaults to AllowLinkingAccountAddresses, the only
    // one valid for a UUID sweep. Fee must be null (always ZIP 317). Errors
    // like "no UTXOs to shield" just mean the miner hasn't produced anything
    // spendable yet; the reconciler treats a failed step as "try again next
    // tick".
    const op = await this.rpc<{ opid?: string; remainingUTXOs?: number }>(
      "z_shieldcoinbase",
      `[${JSON.stringify(account)},${JSON.stringify(address)},null,${SHIELD_UTXO_LIMIT}]`,
    );
    if (!op?.opid) return; // nothing to shield this tick
    await this.awaitOperation(op.opid);
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
