/**
 * Best-effort live node/wallet sync for /api/status, so the UI can honestly show
 * "preparing / X% / ready". In zallet mode we ask the wallet for getwalletstatus
 * (its view of node_tip vs its own scanned wallet_tip). If the wallet isn't up
 * yet — which is exactly the case while zebra does its first sync — this returns
 * null and the UI shows an indeterminate "bringing the node online" state.
 */
import { config } from "../config.ts";
import { getExternalTip } from "./externalTip.ts";

export interface NodeStatus {
  ready: boolean;
  syncPercent: number | null;
  height: number | null; // wallet-scanned height
  nodeHeight: number | null; // node tip (OUR node's self-report)
  externalHeight: number | null; // network tip per an independent source (null = couldn't verify)
  frozen: boolean; // our node has fallen far behind the real network (#170)
}

// How far our node may lag the independent tip before we call it frozen. Normal
// lag is a few blocks and our node can even read slightly AHEAD of the external
// source (its aggregate poll is a little stale), so the threshold is generous.
// A genuinely frozen node diverges by hundreds to thousands and keeps growing
// (Fauzec's faucet was 12,607 behind), so this catches a real freeze without
// false-alarming on normal lag or a fast burst of blocks.
const FREEZE_BLOCKS = Number(process.env.FAUCET_FREEZE_BLOCKS ?? 200);

export async function getNodeStatus(): Promise<NodeStatus | null> {
  if (config.sender !== "zallet") return null;
  const { endpoint, user, password } = config.zallet;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

  try {
    // Ask our own node where it thinks the tip is. This is the only network call
    // on the readiness path — the independent tip is a cached, non-blocking read
    // (see externalTip.ts) so a slow public endpoint can never slow /api/ready.
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

    // Frozen only on POSITIVE evidence: the network is reachable AND our node's
    // tip is far below it. A null external tip means we could not verify — we do
    // NOT flip to frozen on that (never let a public-endpoint outage take down a
    // healthy faucet), but readiness stops claiming more than it knows.
    const externalHeight = getExternalTip();
    const frozen = externalHeight != null && externalHeight - n > FREEZE_BLOCKS;

    const walletCaughtUp = n > 0 && w >= n - 5;
    return { ready: walletCaughtUp && !frozen, syncPercent, height: w, nodeHeight: n, externalHeight, frozen };
  } catch {
    return null;
  }
}
