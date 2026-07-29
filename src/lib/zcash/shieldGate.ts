/**
 * May we broadcast a coinbase shield right now?
 *
 * This lives in its own file on purpose. The readiness check in nodeStatus.ts
 * asks a similar-looking question about the same two heights and deliberately
 * FAILS OPEN — a public-endpoint outage must never take down a healthy faucet.
 * This one must FAIL CLOSED: cannot-verify is not clearance to move money. Those
 * two rules cannot share a neighbourhood without someone eventually copying the
 * wrong one, because the copy reads as consistency.
 *
 * WHY IT EXISTS (#172): on 2026-07-29 the refiller built a 1.25 TAZ coinbase
 * shield at 07:56:45Z. Its expiry height, 4,217,981, had already been mined at
 * 07:56:41Z — four seconds earlier. The transaction was born expired: our node
 * believed the tip was 4,217,941 while the network was at least 40 blocks ahead.
 * It could never be mined at any fee, it sat in the wallet as an unfetchable
 * reference, and zallet then crash-looped 400+ times on it.
 *
 * Zcash sets expiry at tip+40, so a node lagging 40 blocks produces transactions
 * that are dead on arrival. FAUCET_FREEZE_BLOCKS is 200, five times too loose to
 * notice: throughout that failure the freeze flag read false, correctly by its own
 * definition. Two different questions were sharing one threshold:
 *
 *   is our chain view so stale we would serve lies?      200 is arguable
 *   is it fresh enough to BUILD a valid transaction?     anything near 40 is fatal
 *
 * So this gate gets its own, much tighter budget, and 40 is the cliff rather than
 * the target — the default leaves an order of magnitude of headroom.
 */

import { getExternalTip } from "./externalTip.ts";

/*
 * The decision itself is a PURE function of two heights (see shieldFreshness),
 * following the same convention as the reserve's decide.ts: rules with no imports,
 * so every branch — including the ones that only happen when a public endpoint is
 * down — is reachable in a test without mocking a module or touching a network.
 * readShieldFreshness() is the thin wrapper that supplies the live oracle value.
 */

/**
 * Three states, not a boolean. A boolean forces the unverifiable case to collapse
 * into one of the other two, and whoever does the collapsing eventually picks the
 * permissive side. Same reasoning as the tip oracle's null, the watchdog's
 * cannot-tell, and #174's count-not-reported: a missing tip is not a safe tip.
 */
export type ShieldFreshness = "safe" | "unsafe" | "unverifiable";

export interface ShieldGate {
  state: ShieldFreshness;
  nodeHeight: number | null;
  externalHeight: number | null;
  /** externalHeight - nodeHeight when both are known; negative means we are ahead. */
  lag: number | null;
  /** Operator-facing sentence. Always populated, including when safe. */
  reason: string;
}

/**
 * Blocks our node may lag the independently-observed tip and still be trusted to
 * build a transaction. Deliberately far below Zcash's 40-block expiry delta: 40 is
 * where the arithmetic guarantees death, not where safety ends, and a ceiling is
 * not a target (the same trap as FAUCET_POW_MAX_BITS in #132).
 */
export const SHIELD_MAX_LAG_BLOCKS = Number(process.env.FAUCET_SHIELD_MAX_LAG_BLOCKS ?? 5);

/**
 * @param nodeHeight     our own node's tip, or null when we could not read it.
 * @param externalHeight the independently-observed network tip, or null when the
 *                       oracle has nothing fresh enough to claim.
 *
 * A null nodeHeight yields unverifiable, which is correct rather than merely safe:
 * in this deployment the only source of it is the wallet, and a wallet we cannot
 * reach cannot shield anything either. So there is no circularity to escape here,
 * unlike the diagnostic question of "is our node caught up" while the wallet is
 * down — that one needs a direct zebra read and is answered outside the app.
 */
export function shieldFreshness(
  nodeHeight: number | null,
  externalHeight: number | null,
): ShieldGate {
  if (nodeHeight == null) {
    return {
      state: "unverifiable",
      nodeHeight,
      externalHeight,
      lag: null,
      reason: "our node's height is unknown, so freshness cannot be established",
    };
  }

  if (externalHeight == null) {
    return {
      state: "unverifiable",
      nodeHeight,
      externalHeight,
      lag: null,
      // Spelled out because the tempting reading is "no news is good news", and
      // that reading is what produced a born-expired transaction.
      reason:
        "no independently-verified network tip is available, so we cannot tell whether " +
        "our node is current; refusing to broadcast rather than assuming it is",
    };
  }

  const lag = externalHeight - nodeHeight;

  if (lag > SHIELD_MAX_LAG_BLOCKS) {
    return {
      state: "unsafe",
      nodeHeight,
      externalHeight,
      lag,
      reason:
        `our node is ${lag} blocks behind the network (limit ${SHIELD_MAX_LAG_BLOCKS}); ` +
        "a transaction built now risks an expiry height the network has already passed",
    };
  }

  return {
    state: "safe",
    nodeHeight,
    externalHeight,
    lag,
    reason: `our node is within ${SHIELD_MAX_LAG_BLOCKS} blocks of the network (lag ${lag})`,
  };
}

/**
 * The only helper callers should use to decide whether to broadcast. It exists so
 * no call site ever writes `state !== "unsafe"`, which would let unverifiable
 * through — the precise mistake this module's shape is designed to prevent.
 */
export function mayShield(gate: ShieldGate): boolean {
  return gate.state === "safe";
}

/** Live reading: the pure decision above, fed the current cached oracle value. */
export function readShieldFreshness(nodeHeight: number | null): ShieldGate {
  return shieldFreshness(nodeHeight, getExternalTip());
}
