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
  node: { ready: boolean; frozen: boolean; shield: { state: ChainFreshness; lag: number | null } } | null;
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
  if (i.node && i.node.ready === false) return "node syncing";
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
