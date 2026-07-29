/**
 * Best-effort live node/wallet sync for /api/status, so the UI can honestly show
 * "preparing / X% / ready". In zallet mode we ask the wallet for getwalletstatus
 * (its view of node_tip vs its own scanned wallet_tip). If the wallet isn't up
 * yet — which is exactly the case while zebra does its first sync — this returns
 * null and the UI shows an indeterminate "bringing the node online" state.
 */
import { config } from "../config.ts";
import { getExternalTip } from "./externalTip.ts";
import { readShieldFreshness, type ShieldGate } from "./shieldGate.ts";
import { tipProgress, type TipSample } from "./tipProgress.ts";

export interface NodeStatus {
  ready: boolean;
  syncPercent: number | null;
  height: number | null; // wallet-scanned height
  nodeHeight: number | null; // node tip (OUR node's self-report)
  externalHeight: number | null; // network tip per an independent source (null = couldn't verify)
  frozen: boolean; // our node has fallen far behind the real network (#170)
  /** How long our tip has sat unchanged, or null when we cannot say yet. */
  tipStalledMs: number | null;
  /**
   * Whether our chain view is fresh enough to BUILD a transaction — a different and
   * much tighter question than `frozen`, and deliberately not derived from it. See
   * shieldGate.ts for why they must not share a threshold: a 40-block lag produces
   * born-expired transactions while `frozen` (200) still reads false (#172).
   * Surfaced here so it is observable from /api/status; the refusal itself belongs
   * at the broadcast site.
   */
  shield: ShieldGate;
}

// How far our node may lag the independent tip before we call it frozen. Normal
// lag is a few blocks and our node can even read slightly AHEAD of the external
// source (its aggregate poll is a little stale), so the threshold is generous.
// A genuinely frozen node diverges by hundreds to thousands and keeps growing
// (Fauzec's faucet was 12,607 behind), so this catches a real freeze without
// false-alarming on normal lag or a fast burst of blocks.
const FREEZE_BLOCKS = Number(process.env.FAUCET_FREEZE_BLOCKS ?? 200);

// Remembered across calls so the motion check has something to compare against.
// Process-local by design: a restart legitimately forgets, and a fresh process
// must not claim a stall it has not observed.
let lastTip: TipSample | null = null;

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

    // Frozen only on POSITIVE evidence, from two independent signals.
    //
    // DISTANCE: the network is reachable AND our tip is far below it. A null
    // external tip means we could not verify, and we do NOT flip to frozen on that
    // — a public-endpoint outage must never take down a healthy faucet.
    const externalHeight = getExternalTip();
    const behind = externalHeight != null && externalHeight - n > FREEZE_BLOCKS;

    // MOTION: our own tip has not advanced in a long time. This needs no second
    // opinion, so it still works while the oracle is down — which is exactly when
    // the distance check goes quiet. It also catches a node wedged just behind the
    // tip, which is close enough to look fine by distance and just as stuck.
    const progress = tipProgress(lastTip, n, Date.now());
    lastTip = progress.next;

    const frozen = behind || progress.stalled;

    const walletCaughtUp = n > 0 && w >= n - 5;
    return {
      ready: walletCaughtUp && !frozen,
      syncPercent,
      height: w,
      nodeHeight: n,
      externalHeight,
      frozen,
      tipStalledMs: progress.stalledMs,
      shield: readShieldFreshness(n),
    };
  } catch {
    return null;
  }
}
