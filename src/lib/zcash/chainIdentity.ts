/**
 * Are we on the real chain? Three questions, not one (#249).
 *
 *   CURRENT  our tip is not lagging          #171, shipped, gates transactions
 *   RULES    we did not miss an upgrade      consensusBranchId, compared here
 *   HISTORY  we are not on a minority fork   block hash at a common height, here
 *
 * Height cannot separate them, which is the whole point. A node far AHEAD of every
 * external reference looks identical to a node on its own fork, and #233 made the
 * shield gate's reason string say so. Saying it is not detecting it.
 *
 * This module is the comparison only. It takes facts and returns a verdict, so every
 * branch is reachable in a test without a node, a network, or a fork to hand. The
 * wiring question, which RPC supplies our block hash, is deliberately not decided
 * here: our app currently reads only zallet, and whether zallet exposes getblockhash
 * or we add a zebra path changes nothing about the rules below.
 */

/** `forked` is a claim about the CHAIN. `cannot-verify` is a claim about the LOOKUP. */
export type IdentityState = "same-chain" | "different-rules" | "forked" | "cannot-verify";

export interface IdentityFacts {
  /** Consensus branch id our node reports. */
  ourBranchId: string | null;
  /** Consensus branch id an independent source reports. */
  theirBranchId: string | null;
  /** The height both hashes were read at. Must be the SAME height or the comparison is meaningless. */
  comparedAtHeight: number | null;
  ourHashAtHeight: string | null;
  theirHashAtHeight: string | null;
}

export interface IdentityVerdict {
  state: IdentityState;
  reason: string;
}

/**
 * How far below the tip to compare. A hash read at the tip disagrees routinely and
 * innocently, because two nodes seconds apart have different tips and one of them is
 * about to be reorged away. Comparing back from the tip asks about settled history
 * instead, which is the question worth asking.
 *
 * 20 blocks is roughly 25 minutes at testnet's 75s target. Deep enough that a
 * disagreement means a real split rather than propagation, shallow enough that a
 * fork is caught the same hour it starts.
 */
export const COMPARE_DEPTH_BLOCKS = 20;

/** The height to compare at, or null when we cannot pick one honestly. */
export function comparisonHeight(ourTip: number | null, theirTip: number | null): number | null {
  if (ourTip === null || theirTip === null) return null;
  // The lower of the two, then back off. Using our own tip would ask them about a
  // block they may not have yet, and read the resulting absence as a fork.
  const common = Math.min(ourTip, theirTip) - COMPARE_DEPTH_BLOCKS;
  return common > 0 ? common : null;
}

export function classifyChainIdentity(f: IdentityFacts): IdentityVerdict {
  // RULES first, because different rules explain a hash mismatch and the reverse is
  // not true. Reporting "forked" when we simply missed an upgrade would send someone
  // hunting a split that does not exist.
  if (f.ourBranchId !== null && f.theirBranchId !== null && f.ourBranchId !== f.theirBranchId) {
    return {
      state: "different-rules",
      reason:
        `our node reports consensus branch ${f.ourBranchId}, the independent source reports ` +
        `${f.theirBranchId}. We are validating by different rules, which usually means a network ` +
        `upgrade activated and we did not take it. Any hash mismatch below follows from this`,
    };
  }

  if (f.ourBranchId === null || f.theirBranchId === null) {
    return {
      state: "cannot-verify",
      reason: "a consensus branch id is missing, so whether we share rules is unestablished",
    };
  }

  if (f.comparedAtHeight === null) {
    return {
      state: "cannot-verify",
      reason: "no common height could be chosen, so history was not compared. Rules match",
    };
  }

  if (f.ourHashAtHeight === null || f.theirHashAtHeight === null) {
    return {
      state: "cannot-verify",
      reason: `a block hash at height ${f.comparedAtHeight} is missing, so history was not compared. Rules match`,
    };
  }

  // Case-insensitive: sources differ on hex case and a case difference is not a fork.
  if (f.ourHashAtHeight.toLowerCase() !== f.theirHashAtHeight.toLowerCase()) {
    return {
      state: "forked",
      reason:
        `at height ${f.comparedAtHeight} our node has block ${f.ourHashAtHeight} and the ` +
        `independent source has ${f.theirHashAtHeight}. Same rules, different history, so this ` +
        `is a chain split and we are on the minority side of it or they are`,
    };
  }

  return {
    state: "same-chain",
    reason: `same rules (${f.ourBranchId}) and same history at height ${f.comparedAtHeight}`,
  };
}

/**
 * Only a proven split or proven rule divergence is worth acting on. `cannot-verify`
 * must never reach here as an alarm: every source we have is intermittent, and an
 * unreachable explorer is not a fork.
 */
export function isChainProblem(v: IdentityVerdict): boolean {
  return v.state === "forked" || v.state === "different-rules";
}
