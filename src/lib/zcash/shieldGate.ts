/**
 * Is our chain view fresh enough to BUILD a transaction that can actually confirm?
 *
 * Not shield-specific, despite the filename. A drip and a coinbase shield are the
 * same question: both are transactions this wallet builds, both get an expiry height
 * of tip+40, and both are born dead if our node's tip is stale. #187 is what happens
 * when only one of them asks. The filename stays for now so #171 and #186 do not need
 * reworking mid-flight, and renaming the file is a follow-up once both have landed.
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
import { getExternalTip, warmExternalTip } from "./externalTip.ts";

/*
 * The decision itself is a PURE function of two heights (see shieldFreshness),
 * following the same convention as the reserve's decide.ts: rules with no imports,
 * so every branch — including the ones that only happen when a public endpoint is
 * down — is reachable in a test without mocking a module or touching a network.
 * readChainFreshness() is the thin wrapper that supplies the live oracle value.
 */

/**
 * Three states, not a boolean. A boolean forces the unverifiable case to collapse
 * into one of the other two, and whoever does the collapsing eventually picks the
 * permissive side. Same reasoning as the tip oracle's null, the watchdog's
 * cannot-tell, and #174's count-not-reported: a missing tip is not a safe tip.
 */
export type ChainFreshness = "safe" | "unsafe" | "unverifiable";

export interface ChainGate {
  state: ChainFreshness;
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
export function chainFreshness(
  nodeHeight: number | null,
  externalHeight: number | null,
): ChainGate {
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

  // AHEAD is a different fact from WITHIN, and folding them together made this
  // string state something untrue (#211). Read off the live endpoint during the
  // recovery pre-flight: lag -91 with the reason "our node is within 5 blocks of
  // the network (lag -91)". The verdict was right and the sentence was not, and a
  // human read it while deciding whether to move money.
  //
  // Worth its own branch rather than a tweak to the number, because a reason that
  // recites the safe-path sentence for every safe input is exactly what would hide
  // a threshold bug: the watchdog's 812 recoveries were the same failure, scaled up.
  if (lag < 0) {
    return {
      state: "safe",
      nodeHeight,
      externalHeight,
      lag,
      // Deliberately claims LESS than the within-threshold case. A node far ahead of
      // every external reference is also what a node on its own fork looks like, and
      // height alone cannot tell those apart: that needs same-rules (branch id) or
      // same-history (hash at a common height), neither of which this gate measures.
      // So it says why being ahead is fine for EXPIRY and stops there.
      reason:
        `our node is ${-lag} blocks AHEAD of the independent reference. Normal for a node ` +
        `that mines, and safe for an expiry height because ahead cannot be stale. It is not ` +
        `evidence that we agree with the network, which height alone cannot show`,
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
 *
 * Named for the general question rather than the shield, because the drip path asks
 * it too (#187). A gate called mayShield() guarding a user's drip is a lie at the
 * call site, and a misleading name on a money gate is how someone eventually decides
 * it does not apply to them and writes the `!== "unsafe"` version by hand.
 */
export function mayBuildTransaction(gate: ChainGate): boolean {
  return gate.state === "safe";
}

/** Live reading: the pure decision above, fed the current cached oracle value. */
export function readChainFreshness(nodeHeight: number | null): ChainGate {
  return chainFreshness(nodeHeight, getExternalTip());
}

/**
 * Longest we will make a caller wait for the oracle before deciding without it.
 * The request path is the constraint: two seconds is tolerable in front of a drip
 * that takes seconds to build anyway, and it is well under any sane client timeout.
 */
const ORACLE_WAIT_MS = 2000;

/**
 * The reading for a caller that is ABOUT TO BUILD a transaction, rather than one
 * reporting status.
 *
 * The difference is worth a whole function. getExternalTip() is deliberately
 * NON-BLOCKING: it returns the cached value and only kicks a refresh afterwards, so
 * a slow public endpoint can never slow /api/ready. The consequence is that the
 * FIRST read after the cache ages out returns null even when the network is
 * perfectly reachable, because the refresh it triggers has not landed yet.
 *
 * Fail-closed then turns a cold cache into a refused payout. A faucet with no
 * traffic for five minutes would refuse the next legitimate claim, and the user
 * would be told our node is behind when the truth is that we had not asked lately.
 * Found by running the integration suite: server C's claim was refused mid-run for
 * exactly this reason, with a wallet and a node that were both fine.
 *
 * So a caller on the money path ASKS, bounded, before deciding. "We cannot verify"
 * has to mean the network would not tell us, never that we did not get round to
 * checking. If the wait expires with nothing, we are back to unverifiable and refuse
 * as before, which is the honest outcome rather than a softened one.
 */
export async function readChainFreshnessAsking(
  nodeHeight: number | null,
  waitMs = ORACLE_WAIT_MS,
): Promise<ChainGate> {
  // POLL for the value rather than awaiting one refresh. warmExternalTip() returns
  // IMMEDIATELY when a refresh is already in flight (externalTip.ts guards on a
  // `refreshing` flag), so awaiting it once can be a silent no-op: the read that
  // returned null a moment ago is exactly what kicked the refresh we would then be
  // waiting on. That bug shipped in the first version of this function and the
  // integration suite caught it, refusing a claim against a healthy wallet.
  const deadline = Date.now() + waitMs;
  while (getExternalTip() == null && Date.now() < deadline) {
    void warmExternalTip();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return chainFreshness(nodeHeight, getExternalTip());
}

/*
 * Shield-flavoured aliases. The shield path is a caller like any other now, so these
 * exist only so #171 and #186 do not have to be reworked while they are in flight.
 * New call sites should use the general names.
 */
export type ShieldFreshness = ChainFreshness;
export type ShieldGate = ChainGate;
export const mayShield = mayBuildTransaction;
export const readShieldFreshness = readChainFreshness;
export const shieldFreshness = chainFreshness;
