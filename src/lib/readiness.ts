/**
 * The readiness verdict, as a pure function of what the probes said.
 *
 * Pulled out of the route so the ORDER of reasons and the one asymmetry in it can be
 * tested without booting a stack. The asymmetry is the send gate (risk register #7,
 * 2026-09-08): our node measurably behind an independent tip ("unsafe") makes the faucet
 * not ready, because every claim would be refused and a transaction built now would
 * expire; a tip we merely cannot verify ("unverifiable") does NOT, because redeploy rolls
 * back on this verdict and a public oracle's outage must never roll back a good deploy.
 * The refusal is not hidden in that case: the route puts node.canBuildTx in the body and
 * the watchdog and the off-box probe page on it.
 *
 * A stack whose backend is down cannot exercise that asymmetry end to end (backend
 * unreachable outranks everything), which is exactly why it is pinned here instead.
 */
import type { ChainFreshness } from "./zcash/shieldGate.ts";

export interface ReadinessInputs {
  /** ledgerBlocksServing(): a DEFINITE ledger failure. Unknown is false. */
  ledgerBlocks: boolean;
  backendReachable: boolean;
  /** null when the node was not asked or did not answer. Which of the two it is matters:
   *  see nodeExpected. */
  /** `height` is the WALLET's own scanned height and `nodeHeight` is our node's tip - the two
   *  names getNodeStatus() gives them (nodeStatus.ts:129-130). They are here so the rung below
   *  can say WHICH of the two is behind; without them the reason could only name the block.
   *  number|null rather than number: both are unreadable states the node status really reports. */
  node: {
    ready: boolean; frozen: boolean;
    height?: number | null; nodeHeight?: number | null;
    shield: { state: ChainFreshness; lag: number | null };
  } | null;
  /** True when this deployment HAS a node to ask (sender is zallet). A null node beside
   *  true is a node that did not answer, and the claim path refuses in that state (the
   *  gate is unverifiable without a node height), so readiness must too. Before this,
   *  a wallet that answered its balance but not its status gave a 200 with no node block,
   *  and every pager that reads canBuildTx out of that block saw nothing to read. */
  nodeExpected: boolean;
  balanceZat: bigint | null;
  /** sendHealthBlocksServing(): a DEFINITE send-health failure, with its reason. */
  sendsBlock: boolean;
  sendsReason: string | null;
  /** dripZatoshi + minReserveZatoshi. */
  floorZat: bigint;
}

/** The most upstream blocker, or null when a drip can be served. */
export function readinessReason(i: ReadinessInputs): string | null {
  if (i.ledgerBlocks) return "ledger unreadable";
  if (!i.backendReachable) return "backend unreachable";
  if (i.nodeExpected && i.node == null) return "node status unknown";
  if (i.node && i.node.frozen) return "node frozen behind network";
  // THE WALLET, NOT THE NODE, AND IT IS NEVER THE NODE HERE. This said "node syncing", which
  // sent an operator to zebra - healthy, at the tip, nothing to find. Nine minutes of it in
  // production on 2026-09-16 (#596), while the thing behind was the wallet, by 50 then ~92
  // blocks, re-scanning after a crash (#602).
  //
  // It is wrong EVERY time it fires, not sometimes, and the ladder is what makes that true:
  // `ready` is `walletCaughtUp && !frozen` (nodeStatus.ts:129) and `frozen` is caught by the
  // rung ABOVE this one, so by the time control arrives here `frozen` is false and the only
  // term left that can be false is `walletCaughtUp`. There is no reachable state in which this
  // line fires because of the node. The test below pins that rather than this paragraph.
  //
  // "re-scanning" is the CTO's word, ruled at 11:33Z and again at 12:39Z. I argued once for
  // "scanning" - a wallet restored from seed or freshly deployed is behind for the same reason
  // and has never scanned before, so the prefix is false in that state - and the ruling stands,
  // so it ships. Recorded rather than re-argued: the lag beside it is right in both states and
  // is the number an operator acts on.
  //
  // THE STRING IS READ BY deploy/z3/redeploy.sh, which is why that file moves in this commit:
  // `reason_is_not_the_code()` matched "node syncing" and would have stopped matching, turning
  // a re-scanning wallet into a rollback that cannot fix it.
  if (i.node && i.node.ready === false) {
    const lag = i.node.nodeHeight != null && i.node.height != null
      ? i.node.nodeHeight - i.node.height
      : null;
    return lag == null
      ? "wallet re-scanning, behind our node"
      : `wallet re-scanning, ${lag} blocks behind our node`;
  }
  // Only "unsafe". See the module comment: "unverifiable" stays ready on purpose. lag is
  // always known when the state is unsafe (chainFreshness needs both heights to say so),
  // so the number in the reason is a number.
  if (i.node && i.node.shield.state === "unsafe")
    return `node ${i.node.shield.lag} blocks behind the network, drips would expire`;
  if (i.balanceZat === null) return "wallet balance unknown";
  if (i.sendsBlock) return `sends failing: ${i.sendsReason ?? "unknown"}`;
  if (i.balanceZat < i.floorZat) return "below reserve, refilling";
  return null;
}
