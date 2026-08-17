/**
 * Is our WALLET's scan caught up enough to build a transaction that can confirm?
 *
 * A DIFFERENT QUESTION TO shieldGate.ts, and the gap between them cost a ten-hour
 * outage on 2026-08-17. That gate compares OUR NODE to an independent tip and answers
 * "is our node following the network". This one compares OUR WALLET to OUR OWN NODE and
 * answers "has our wallet finished scanning what our node already has".
 *
 * Both were needed because zallet does not stamp expiry from the node's tip. It stamps
 * it from the height its own WALLET has scanned to. The incident arithmetic, from the
 * zebra rejection and /api/ready in the same minute:
 *
 *     wallet scanned 4,279,669  +40  ->  expiry 4,279,710
 *     node tip       4,279,780              already 70 past it
 *
 *     RPC -25: transaction must not be mined at a block Height(4279780)
 *              greater than its expiry Height(4279710)
 *
 * Every drip built in that window was BORN EXPIRED. shieldGate said "safe" throughout
 * and was right on its own terms: the node was fresh, in fact four blocks AHEAD of the
 * independent reference. Nothing was watching the wallet.
 *
 * WHY THAT MATTERED MORE THAN A FEW FAILED SENDS. A born-expired transaction is not a
 * clean failure. It lands in the wallet as a row zallet asks zebra about on every boot,
 * zebra correctly answers "no such transaction", zaino classifies that UNRECOVERABLE
 * rather than not-found, and the wallet exits. The restart policy then serves the
 * identical death forever. So serving drips while the wallet lagged did not just fail
 * four users, it manufactured the poison that took the faucet down again ten minutes
 * after it was repaired. This gate is the tap; the repair scripts in deploy/z3 are the
 * mop.
 *
 * FAIL CLOSED, both ways. A height we cannot read is "unverifiable" and refuses, for the
 * same reason shieldGate refuses an unverifiable tip: the cost of a wrong "safe" here is
 * a dead transaction plus a crash-looping wallet, and the cost of a wrong "refuse" is a
 * user coming back in a minute.
 */
import { num } from "../config.ts";

export type WalletLagState = "safe" | "unsafe" | "unverifiable";

export interface WalletLagGate {
  state: WalletLagState;
  /** Height our wallet has scanned to, or null when unreadable. */
  walletHeight: number | null;
  /** Our own node's tip, or null when unreadable. */
  nodeHeight: number | null;
  /** nodeHeight - walletHeight when both are known; <=0 means fully caught up. */
  lag: number | null;
  /** Operator-facing sentence. Always populated, including when safe. */
  reason: string;
}

/** Zcash expires a transaction at scanned+40, so a lag of 40 guarantees death. */
export const EXPIRY_DELTA_BLOCKS = 40;

/**
 * Hard ceiling on the budget, clamped rather than trusted to a comment - the same
 * lesson shieldGate learned when 500 in an env file made a fatal lag read "safe".
 */
export const WALLET_LAG_CEILING = 20;

/**
 * Blocks our wallet may trail our own node and still be trusted to build a drip.
 *
 * Well below the 40 where the arithmetic guarantees death, because 40 is the cliff and
 * not the safe edge: blocks keep arriving while a shielded send is being proved and
 * broadcast, so a transaction built at a lag of 39 can still be overtaken before it
 * reaches the mempool. 10 leaves room for that and is still generous next to the 70-110
 * seen during the incident.
 */
export const WALLET_MAX_LAG_BLOCKS = (() => {
  const configured = num("FAUCET_WALLET_MAX_LAG_BLOCKS", 10);
  if (configured > WALLET_LAG_CEILING) {
    console.warn(
      `[walletLagGate] FAUCET_WALLET_MAX_LAG_BLOCKS=${configured} exceeds the ceiling of ` +
        `${WALLET_LAG_CEILING} (zallet expires at scanned+${EXPIRY_DELTA_BLOCKS}); clamping to ${WALLET_LAG_CEILING}`,
    );
    return WALLET_LAG_CEILING;
  }
  // Stricter values (including 0 or negative) are allowed: they only refuse more.
  return configured;
})();

/**
 * Pure function of the two heights, so every branch is reachable in a test without a
 * network or a mocked module.
 *
 * @param walletHeight height our wallet has scanned to, null when unreadable
 * @param nodeHeight   our own node's tip, null when unreadable
 */
export function walletLagFreshness(
  walletHeight: number | null,
  nodeHeight: number | null,
): WalletLagGate {
  if (walletHeight == null || nodeHeight == null) {
    return {
      state: "unverifiable",
      walletHeight,
      nodeHeight,
      lag: null,
      reason:
        walletHeight == null
          ? "our wallet's scanned height is unknown, so we cannot tell whether a drip would be born expired"
          : "our node's tip is unknown, so we cannot measure how far the wallet trails it",
    };
  }

  const lag = nodeHeight - walletHeight;

  // A wallet AHEAD of the node is not a lag. It happens transiently while the node is
  // mid-write, and it cannot produce a stale expiry, so it is safe rather than suspect.
  if (lag <= 0) {
    return {
      state: "safe",
      walletHeight,
      nodeHeight,
      lag,
      reason: "our wallet has scanned everything our node has, so a drip's expiry is stamped from a current height",
    };
  }

  if (lag > WALLET_MAX_LAG_BLOCKS) {
    return {
      state: "unsafe",
      walletHeight,
      nodeHeight,
      lag,
      reason:
        `our wallet trails our own node by ${lag} block(s), over the ${WALLET_MAX_LAG_BLOCKS} budget. ` +
        `zallet stamps expiry from the scanned height, so a drip built now would expire at ` +
        `${walletHeight + EXPIRY_DELTA_BLOCKS}` +
        (lag >= EXPIRY_DELTA_BLOCKS
          ? ` - already behind the tip at ${nodeHeight}, so it could never be mined`
          : ` and could be overtaken before it is proved and broadcast`),
    };
  }

  return {
    state: "safe",
    walletHeight,
    nodeHeight,
    lag,
    reason: `our wallet trails our node by ${lag} block(s), inside the ${WALLET_MAX_LAG_BLOCKS} budget`,
  };
}

/**
 * True ONLY for "safe". Written as an allow-list rather than `state !== "unsafe"` so a
 * state added later refuses by default instead of silently passing - the failure shape
 * shieldGate documents and this module inherits deliberately.
 */
export function mayBuildFromWallet(gate: WalletLagGate): boolean {
  return gate.state === "safe";
}
