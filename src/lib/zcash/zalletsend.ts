/**
 * Shielded-native sender backed by a Zallet wallet (the Z3 stack: zebrad +
 * zaino-in-zallet + zallet). Unlike the transparent RealSender and the t2z
 * bridge — both of which spend a *transparent* faucet wallet whose balance and
 * every drip's origin are public — this one holds Orchard notes and pays
 * recipients fully shielded (z→z). The faucet's holdings and the link between
 * faucet and claimant stay private.
 *
 * It talks to a running `zallet start` over its JSON-RPC interface (HTTP Basic
 * auth against a `[[rpc.auth]]` user). The relevant calls:
 *
 *   balance()  z_getbalanceforaccount <account-uuid>  → sum the pool values
 *   send()     z_sendmany <ua> [{address,amount}] …   → an opid (async),
 *              then z_getoperationstatus / z_getoperationresult until it lands.
 *
 * z_sendmany is asynchronous: it returns immediately with an `opid-…` while the
 * wallet builds + proves the tx in the background, so we poll for the txid. Fees
 * are ZIP-317, set by the wallet. See the Zallet book:
 *   https://zcash.github.io/wallet/guide/first-wallet.html
 */
import { SendOutcomeUnknownError, type Sender, type SendRequest, type SendResult } from "./send.ts";
// .ts extension for node --test resolution, same pattern as pow.ts.
import { config, ZATOSHI_PER_TAZ } from "../config.ts";
import { explorerTxUrl } from "./explorer.ts";
// Transient RPC blips should not kill a send that is otherwise progressing.
// POLL_RETRIES lives in sendBudget.ts because the send queue's backstop deadline
// is computed from it, and two copies would drift apart silently.
import { POLL_RETRIES } from "./sendBudget.ts";

/** Render zatoshi as an exact ZEC decimal literal (no float drift). */
function zatToZecLiteral(zat: bigint): string {
  const whole = zat / ZATOSHI_PER_TAZ;
  const frac = (zat % ZATOSHI_PER_TAZ).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}


interface RpcError {
  code: number;
  message: string;
}
interface OperationResult {
  id: string;
  status: "queued" | "executing" | "success" | "failed" | "cancelled";
  result?: { txid?: string };
  error?: RpcError;
}

export class ZalletSender implements Sender {
  readonly name = "zallet";

  private get z() {
    return config.zallet;
  }

  /** One JSON-RPC round-trip. Params are embedded verbatim so callers can pass
   *  exact decimal literals (amounts) that JSON.stringify would turn into floats. */
  private async rpc<T>(method: string, paramsJson: string): Promise<T> {
    const { endpoint, user, password } = this.z;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (user) {
      headers.authorization = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
    }
    const body = `{"jsonrpc":"2.0","id":"faucet","method":${JSON.stringify(method)},"params":${paramsJson}}`;

    const ctl = AbortSignal.timeout(this.z.rpcTimeoutMs);
    const res = await fetch(endpoint, { method: "POST", headers, body, signal: ctl });
    if (!res.ok) {
      throw new Error(`zallet RPC ${method} HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { result?: T; error?: RpcError | null };
    if (json.error) throw new Error(`zallet RPC ${method}: ${json.error.message} (code ${json.error.code})`);
    return json.result as T;
  }

  /** Unlock the wallet if a passphrase is configured (encrypted-at-rest hot wallet). */
  private async unlockIfNeeded(): Promise<void> {
    if (!this.z.passphrase) return;
    // walletpassphrase <passphrase> <timeout-seconds>
    await this.rpc<null>(
      "walletpassphrase",
      `[${JSON.stringify(this.z.passphrase)},${this.z.unlockSeconds}]`,
    );
  }

  async balance(): Promise<bigint> {
    if (!this.z.account) throw new Error("FAUCET_ZALLET_ACCOUNT (account UUID) is required for zallet mode.");
    // z_getbalanceforaccount <account> <minconf>
    const bal = await this.rpc<{ pools: Record<string, { valueZat?: number | string }> }>(
      "z_getbalanceforaccount",
      `[${JSON.stringify(this.z.account)},${this.z.minConf}]`,
    );
    let total = 0n;
    for (const pool of Object.values(bal.pools ?? {})) {
      if (pool?.valueZat !== undefined) total += BigInt(pool.valueZat);
    }
    return total;
  }

  async send(req: SendRequest): Promise<SendResult> {
    const { address: from, minConf } = this.z;
    if (!from) throw new Error("FAUCET_ZALLET_ADDRESS (faucet unified address) is required for zallet mode.");

    await this.unlockIfNeeded();

    // Paying a transparent recipient unavoidably reveals it, so the default
    // fully-shielded policy would reject the build — opt in explicitly. Shielded
    // recipients (unified/sapling) keep the strict default.
    const policy = req.addressInfo.kind === "transparent" ? "AllowRevealedRecipients" : "FullPrivacy";
    const amount = zatToZecLiteral(req.amountZat);
    // z_sendmany <fromaddress> [{address,amount}] <minconf> <fee=null> <privacyPolicy>
    const params =
      `[${JSON.stringify(from)},` +
      `[{"address":${JSON.stringify(req.toAddress)},"amount":${amount}}],` +
      `${minConf},null,${JSON.stringify(policy)}]`;

    const opid = await this.rpc<string>("z_sendmany", params);
    const txid = await this.awaitOperation(opid);
    return {
      txid,
      explorerUrl: explorerTxUrl(txid),
    };
  }

  /**
   * Poll the async operation until it lands, then return the broadcast txid.
   *
   * Everything that goes wrong in here is AMBIGUOUS, never a clean failure: the
   * opid already exists, so the wallet may broadcast regardless of what we can
   * observe. Hence SendOutcomeUnknownError rather than a plain throw. The one
   * exception is the wallet telling us outright that the operation failed,
   * which is a definite no-send.
   */
  private async awaitOperation(opid: string): Promise<string> {
    const deadline = Date.now() + this.z.opTimeoutMs;
    const idJson = `[[${JSON.stringify(opid)}]]`;
    // Loop on z_getoperationstatus (non-destructive) so a slow proof doesn't get
    // silently reaped; collect the final result once, which also clears it.
    for (;;) {
      const status = await this.pollStatus(opid, idJson);
      if (status && status.status !== "queued" && status.status !== "executing") break;
      if (Date.now() > deadline) {
        throw new SendOutcomeUnknownError(opid, `still ${status?.status ?? "pending"} after ${this.z.opTimeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, this.z.pollMs));
    }

    let done: OperationResult | undefined;
    try {
      [done] = await this.rpc<OperationResult[]>("z_getoperationresult", idJson);
    } catch (err) {
      // The operation finished, we just could not read how. Coins may be gone.
      throw new SendOutcomeUnknownError(opid, `result unreadable: ${err instanceof Error ? err.message : err}`);
    }
    if (done?.status === "failed" || done?.status === "cancelled") {
      // The wallet is telling us it did not send. This one is definite.
      throw new Error(`zallet send failed: ${done.error?.message ?? done.status}`);
    }
    if (!done || done.status !== "success") {
      throw new SendOutcomeUnknownError(opid, `unexpected final status ${done?.status ?? "missing"}`);
    }
    const txid = done.result?.txid;
    if (!txid) throw new SendOutcomeUnknownError(opid, "succeeded but returned no txid");
    return txid;
  }

  /**
   * One status poll, retried through transient RPC failures. Without this a
   * single blip aborts a send that is building perfectly well. Gives up once
   * the retries are spent, and that give-up is still ambiguous.
   */
  private async pollStatus(opid: string, idJson: string): Promise<OperationResult | undefined> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < POLL_RETRIES; attempt++) {
      try {
        const [status] = await this.rpc<OperationResult[]>("z_getoperationstatus", idJson);
        return status;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, this.z.pollMs * (attempt + 1)));
      }
    }
    throw new SendOutcomeUnknownError(
      opid,
      `status unreadable after ${POLL_RETRIES} tries: ${lastErr instanceof Error ? lastErr.message : lastErr}`,
    );
  }
}
