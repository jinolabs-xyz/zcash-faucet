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

import { num } from "../config.ts";
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

/** Zcash sets a transaction's expiry at tip+40, so a lag of 40 guarantees death. */
export const EXPIRY_DELTA_BLOCKS = 40;

/**
 * Hard ceiling on the lag budget, enforced here rather than trusted to a comment.
 * A budget settable past the cliff by one line in a .env is not a limit.
 */
export const SHIELD_LAG_CEILING = 10;

/**
 * Blocks our node may lag the independently-observed tip and still be trusted to
 * build a transaction. Deliberately far below the 40-block expiry delta: 40 is
 * where the arithmetic guarantees death, not where safety ends, and a ceiling is
 * not a target (the same trap as FAUCET_POW_MAX_BITS in #132).
 *
 * TWO WAYS THIS USED TO FAIL OPEN, both found by SDE-App running it rather than
 * reading it:
 *
 * 1. Number("trlue") is NaN, and `lag > NaN` is FALSE for every lag — so one typo
 *    in a .env made every possible lag read "safe" and mayShield() return true.
 *    A module whose whole thesis is fail-closed, disabled without touching its
 *    logic. num() throws on a value it cannot parse, so we refuse to boot instead:
 *    fail closed on a value we cannot PARSE, exactly as we fail closed on a tip we
 *    cannot VERIFY.
 * 2. The budget was creepable at deploy time. A test asserts the SOURCE default
 *    stays small, but a test does not run in production, and 500 in an env file was
 *    honoured — which made a 40-block lag "safe" again. Hence the clamp.
 */
export const SHIELD_MAX_LAG_BLOCKS = (() => {
  const configured = num("FAUCET_SHIELD_MAX_LAG_BLOCKS", 5);
  if (configured > SHIELD_LAG_CEILING) {
    // Loud, because silently ignoring an operator's setting is its own trap: they
    // would believe a wider budget is in force and plan around it.
    console.warn(
      `[shieldGate] FAUCET_SHIELD_MAX_LAG_BLOCKS=${configured} exceeds the ceiling of ` +
        `${SHIELD_LAG_CEILING} (Zcash expires at tip+${EXPIRY_DELTA_BLOCKS}); clamping to ${SHIELD_LAG_CEILING}`,
    );
    return SHIELD_LAG_CEILING;
  }
  // A negative or zero budget is stricter, not looser, so it is allowed through.
  return configured;
})();

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
