/**
 * Is a payout we believe we made now IMPOSSIBLE?
 *
 * This is the detection half of #202, and it exists because the corroboration half
 * cannot do this job. `payoutExternal.ts` asks other people whether a transaction
 * landed, and every source we measured is intermittent, so its `absent` verdict is
 * effectively unreachable: a flaky explorer answers "I cannot see it", never "it is
 * not there". A check that can only ever confirm is not an alarm.
 *
 * So the alarm is arithmetic on our own node instead, and it is deterministic rather
 * than probabilistic.
 *
 * tx 29 on 2026-07-29 did not fail in a way any explorer could have described. It
 * failed because its expiry height had ALREADY BEEN MINED four seconds before it was
 * created, so no miner could ever include it. Nothing noticed for seven hours.
 *
 * A Zcash transaction carries `expiryheight`. Once our own tip is past it and the
 * transaction is still not in a block, it can never be in one. That needs no external
 * opinion, no source diversity, and no reasoning about whether an explorer is having a
 * bad minute: it is a comparison between two numbers we already fetch.
 *
 * Nothing here requires a schema change. `getrawtransaction <txid> 1` already returns
 * `expiryheight`, and `txstatus.ts` already makes that call for confirmations, so the
 * expiry is a field we were discarding rather than a fact we lacked. Same shape as
 * #199, where `/api/network` was already returning `consensusBranchId`.
 */

/** Deliberately four states. Three of them are not alarms and must not read as one. */
export type PayoutFate =
  /** In a block. Nothing to do. */
  | "mined"
  /** Past its expiry and not in a block. Can NEVER be mined. This is the alarm. */
  | "dead"
  /** Not mined yet, and still could be. Normal for a fresh send. */
  | "pending"
  /** We could not establish it. NOT an alarm, and not an all-clear either. */
  | "cannot-tell";

export interface PayoutFacts {
  /** From the wallet. `null` means the wallet could not answer, which is not "no". */
  knownByWallet: boolean | null;
  /** Confirmations, when the wallet reported them. */
  confirmations: number | null;
  /** The transaction's own `expiryheight`. 0 means "never expires" in Zcash. */
  expiryHeight: number | null;
  /** Our node's tip. `null` when the node could not answer. */
  tip: number | null;
}

export interface PayoutVerdict {
  fate: PayoutFate;
  /** For the log line a human reads, and it must never assert more than was checked. */
  reason: string;
}

/**
 * Pure, so it can be tested exhaustively without a node or a wallet. Every branch
 * below is reachable, and the tests drive all of them: an unreachable branch in an
 * alarm is the same defect as an alarm that cannot fire.
 */
export function classifyPayout(f: PayoutFacts): PayoutVerdict {
  // Mined is checked FIRST and beats everything, including an expired-looking
  // expiry. A transaction that is in a block was included before its expiry by
  // definition, and if our tip and its expiry seem to say otherwise then one of those
  // numbers is stale, not the block.
  if ((f.confirmations ?? 0) > 0) {
    return { fate: "mined", reason: `mined with ${f.confirmations} confirmation(s)` };
  }

  // The wallet not answering is the case most likely to be mistaken for good news,
  // because a wallet that is down produces the same silence as a wallet with nothing
  // to report. It gets its own state, never "pending".
  if (f.knownByWallet === null) {
    return { fate: "cannot-tell", reason: "the wallet could not answer, so nothing about this payout is established" };
  }

  // The wallet saying it has never seen the transaction is interesting but is NOT the
  // expiry alarm, and it must not borrow that alarm's certainty. A send that failed
  // before broadcast looks exactly like this, and so does a restored wallet that lost
  // its view. Report it as its own thing.
  if (f.knownByWallet === false) {
    return {
      fate: "cannot-tell",
      reason: "our wallet has no record of this transaction, so its expiry is unknown and it cannot be judged here",
    };
  }

  if (f.tip === null) {
    return { fate: "cannot-tell", reason: "our node's tip is unknown, so nothing can be compared against the expiry" };
  }

  if (f.expiryHeight === null) {
    return { fate: "cannot-tell", reason: "the transaction reports no expiry height, so it cannot be judged dead" };
  }

  // 0 is not a small expiry, it is the absence of one: a transaction with
  // expiryheight 0 never expires and can be mined at any future height. Treating 0 as
  // a threshold would declare every such payout dead the moment the chain moved,
  // which is the loudest possible false alarm.
  if (f.expiryHeight === 0) {
    return { fate: "pending", reason: "expiry height 0 means this transaction never expires, so it cannot be dead" };
  }

  // The one deterministic conclusion available. Strictly greater than: at tip ==
  // expiryHeight the transaction is still includable in that very block, and calling
  // it dead one block early would page a human about a payout that then lands.
  if (f.tip > f.expiryHeight) {
    return {
      fate: "dead",
      reason:
        `our tip ${f.tip} is past this transaction's expiry ${f.expiryHeight} and it is not in a block, ` +
        `so it can never be mined. This is arithmetic on our own node, not an explorer's opinion`,
    };
  }

  return {
    fate: "pending",
    reason: `not mined yet, ${f.expiryHeight - f.tip} block(s) of expiry headroom left (tip ${f.tip})`,
  };
}

/** Only `dead` is worth waking somebody for. Kept as a function so call sites cannot
 *  re-derive the rule and drift from it, which is how a second copy of a threshold
 *  ends up disagreeing with the first. */
export function shouldAlarm(v: PayoutVerdict): boolean {
  return v.fate === "dead";
}
