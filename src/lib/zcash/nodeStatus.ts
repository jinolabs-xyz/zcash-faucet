/**
 * Best-effort live node/wallet sync for /api/status, so the UI can honestly show
 * "preparing / X% / ready". In zallet mode we ask the wallet for getwalletstatus
 * (its view of node_tip vs its own scanned wallet_tip). If the wallet isn't up
 * yet - which is exactly the case while zebra does its first sync - this returns
 * null and the UI shows an indeterminate "bringing the node online" state.
 */
import { config, num } from "../config.ts";
import { referenceTip } from "./externalTip.ts";
import { mayBuildTransaction, readChainFreshness, type ChainGate } from "./shieldGate.ts";
import { tipProgress, type TipSample } from "./tipProgress.ts";
import { getChainIdentity } from "./chainIdentityOracle.ts";
import type { IdentityVerdict } from "./chainIdentity.ts";

export interface NodeStatus {
  ready: boolean;
  syncPercent: number | null;
  height: number | null; // wallet-scanned height
  nodeHeight: number | null; // node tip (OUR node's self-report)
  externalHeight: number | null; // network tip per an independent source (null = couldn't verify)
  frozen: boolean; // our node has fallen far behind the real network (#170)
  /** The distance half of `frozen`: measurably more than FREEZE_BLOCKS behind an
   * independent tip. False for a motion stall, so a reader can say "N blocks behind"
   * only when N is what tripped it (R-33). */
  behind: boolean;
  /** How long our tip has sat unchanged, or null when we cannot say yet. */
  tipStalledMs: number | null;
  /** The network is not producing blocks either, so a static tip is expected. */
  networkQuiet: boolean;
  /**
   * Whether our chain view is fresh enough to BUILD a transaction - a different and
   * much tighter question than `frozen`, and deliberately not derived from it. See
   * shieldGate.ts for why they must not share a threshold: a 40-block lag produces
   * born-expired transactions while `frozen` (200) still reads false (#172).
   * Surfaced here so it is observable from /api/status; the refusal itself belongs
   * at the broadcast site.
   */
  shield: ChainGate;
  /**
   * Are we on the real chain (#249)? Three states, and cannot-verify is the common
   * one: only the rules half is wired, so this reports a missed upgrade but does not
   * yet detect a split. Diagnostic, never a gate: an unreachable explorer is not a
   * fork and must not stop the faucet serving.
   */
  chain: IdentityVerdict;
  /**
   * The freshness DECISION, not its inputs: may we build a transaction that can
   * actually confirm? Computed here by mayBuildTransaction() so the browser reads a
   * boolean and implements nothing.
   *
   * The point is rule 15 applied to a money rule. The page has to know this to hold
   * a claim instead of sending one that would expire, and it cannot import the gate
   * (shieldGate.ts reaches config and the grpc oracle, both node-only). Left to
   * compare `shield.state` itself, the client would carry a second copy of the rule,
   * and the day the rule gains a state or moves a threshold the copy diverges in
   * silence. That is the `!== "unsafe"` bug wearing a different hat.
   */
  canBuildTx: boolean;
}

// How far our node may lag the independent tip before we call it frozen. Normal
// lag is a few blocks and our node can even read slightly AHEAD of the external
// source (its aggregate poll is a little stale), so the threshold is generous.
// A genuinely frozen node diverges by hundreds to thousands and keeps growing
// (Fauzec's faucet was 12,607 behind), so this catches a real freeze without
// false-alarming on normal lag or a fast burst of blocks.
// num() rather than Number(): NaN would make `externalHeight - n > FREEZE_BLOCKS`
// false for every gap, so the 12,607-block freeze this check was written for (#170)
// would read healthy. Refuse to boot on a value we cannot parse.
const FREEZE_BLOCKS = num("FAUCET_FREEZE_BLOCKS", 200);

// Remembered across calls so the motion check has something to compare against.
// Process-local by design: a restart legitimately forgets, and a fresh process
// must not claim a stall it has not observed.
let lastTip: TipSample | null = null;

/**
 * How long to wait for our own node to answer before calling its height unknown.
 *
 * Floored at 1000ms rather than trusted: an env var set to 0, to a word, or to something
 * negative would disable the status read entirely and every claim would be refused with a
 * sentence about the node - a configuration mistake that presents as an outage.
 */
export function nodeStatusTimeoutMs(): number {
  const raw = Number(process.env.FAUCET_NODE_STATUS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 10_000;
}

export async function getNodeStatus(): Promise<NodeStatus | null> {
  if (config.sender !== "zallet") return null;
  const { endpoint, user, password } = config.zallet;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

  try {
    // Ask our own node where it thinks the tip is. This is the only network call
    // on the readiness path - the independent tip is a cached, non-blocking read
    // (see externalTip.ts) so a slow public endpoint can never slow /api/ready.
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: `{"jsonrpc":"2.0","id":"status","method":"getwalletstatus","params":[]}`,
      // MEASURED, NOT CHOSEN. 4000 was too tight and it was refusing real claims: on production,
      // 2026-09-19, ten samples of /api/status split cleanly either side of this number -
      // 0.9/0.9/1.4/1.9/1.9/2.4/2.8/3.0s answered with a node, and 4.8s and 6.7s answered with
      // node: null. Zallet is simply slower than this sometimes, and every time it was, the page
      // told a visitor "our node did not report its height just now, so we are not sending".
      // The owner found that from their own phone, not from an alert.
      //
      // A TIMEOUT IS A CLAIM ABOUT THE NODE and this one was making it too early: "did not answer
      // in 4s" was being rendered as "we cannot tell whether a drip would confirm", which is a
      // much stronger sentence than the evidence supported.
      //
      // Configurable so the box can move it without a deploy, because the right value is a
      // property of that machine's zallet rather than of this code.
      signal: AbortSignal.timeout(nodeStatusTimeoutMs()),
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
    // - a public-endpoint outage must never take down a healthy faucet.
    //
    // THE HIGHEST NON-STALE REFERENCE, not simply the one the aggregate handed back
    // (#548). On 2026-09-15 at 13:06Z this passed a resyncing node as current for three
    // minutes because the single reference it asked was 113 blocks behind the network
    // while another source knew better and nothing consulted it. Taking the max is what
    // makes a stale source unable to vouch for a node, and it works WITHOUT knowing the
    // source was stale - which matters, because hosh publishes no timestamp and we
    // cannot know (externalTip.ts, REFERENCE_MAX_AGE_MS).
    const externalHeight = referenceTip().height;
    const behind = externalHeight != null && externalHeight - n > FREEZE_BLOCKS;

    // MOTION: our own tip has not advanced in a long time. This needs no second
    // opinion, so it still works while the oracle is down - which is exactly when
    // the distance check goes quiet. It also catches a node wedged just behind the
    // tip, which is close enough to look fine by distance and just as stuck.
    const progress = tipProgress(lastTip, n, externalHeight, Date.now());
    lastTip = progress.next;

    const frozen = behind || progress.stalled;

    const shield = readChainFreshness(n);
    const walletCaughtUp = n > 0 && w >= n - 5;
    return {
      ready: walletCaughtUp && !frozen,
      syncPercent,
      height: w,
      nodeHeight: n,
      externalHeight,
      frozen,
      behind,
      tipStalledMs: progress.stalledMs,
      networkQuiet: progress.networkQuiet,
      shield,
      chain: getChainIdentity(),
      canBuildTx: mayBuildTransaction(shield),
    };
  } catch {
    return null;
  }
}
