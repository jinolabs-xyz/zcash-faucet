/**
 * Best-effort live node/wallet sync for /api/status, so the UI can honestly show
 * "preparing / X% / ready". In zallet mode we ask the wallet for getwalletstatus
 * (its view of node_tip vs its own scanned wallet_tip). If the wallet isn't up
 * yet — which is exactly the case while zebra does its first sync — this returns
 * null and the UI shows an indeterminate "bringing the node online" state.
 */
import { config } from "../config";

export interface NodeStatus {
  ready: boolean;
  syncPercent: number | null;
  height: number | null; // wallet-scanned height
  nodeHeight: number | null; // node tip
}

export async function getNodeStatus(): Promise<NodeStatus | null> {
  if (config.sender !== "zallet") return null;
  const { endpoint, user, password } = config.zallet;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: `{"jsonrpc":"2.0","id":"status","method":"getwalletstatus","params":[]}`,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: { wallet_tip?: { height?: number }; node_tip?: { height?: number } } };
    const w = json.result?.wallet_tip?.height ?? null;
    const n = json.result?.node_tip?.height ?? null;
    if (w == null || n == null) return null;
    const syncPercent = n > 0 ? Math.min(100, (w / n) * 100) : null;
    return { ready: n > 0 && w >= n - 5, syncPercent, height: w, nodeHeight: n };
  } catch {
    return null;
  }
}
