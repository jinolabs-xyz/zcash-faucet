/**
 * Confirmation lookup for a txid, answered by our own wallet.
 *
 * Public explorers render a page for any 64-hex string, real or invented, so a
 * link to one proves nothing (#71). Our node either knows a transaction or it
 * does not.
 */
import { config } from "../config.ts";

export interface TxStatus {
  /** null when the wallet cannot answer, which is different from "not found". */
  known: boolean | null;
  confirmations: number | null;
  height: number | null;
}

const UNKNOWN: TxStatus = { known: null, confirmations: null, height: null };

/** Only zallet mode can answer this, and only for transactions its wallet saw. */
export async function getTxStatus(txid: string): Promise<TxStatus> {
  if (config.sender !== "zallet" || !/^[0-9a-f]{64}$/i.test(txid)) return UNKNOWN;

  const { endpoint, user, password, rpcTimeoutMs } = config.zallet;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: `{"jsonrpc":"2.0","id":"txstatus","method":"getrawtransaction","params":[${JSON.stringify(txid)},1]}`,
      signal: AbortSignal.timeout(rpcTimeoutMs),
    });
    if (!res.ok) return UNKNOWN;
    const json = (await res.json()) as {
      result?: { confirmations?: number; height?: number };
      error?: { code: number } | null;
    };
    // Only -5 (InvalidAddressOrKey, zallet's not-found) is a real "no". Any
    // other error means the wallet could not answer, and reporting that as
    // "not seen" would be a false negative about someone's money.
    if (json.error) {
      return json.error.code === -5 ? { known: false, confirmations: null, height: null } : UNKNOWN;
    }
    if (!json.result) return UNKNOWN;
    return {
      known: true,
      confirmations: json.result.confirmations ?? 0,
      height: typeof json.result.height === "number" && json.result.height >= 0 ? json.result.height : null,
    };
  } catch {
    return UNKNOWN;
  }
}
