/** The wait we ask a refused visitor to sit through. Its own file so it can be tested. */
const FRESHNESS_RETRY_SECONDS = 75;

/**
 * THREE REFUSALS SHARED ONE WAIT, AND ONLY ONE OF THEM DESERVED IT.
 *
 * 75s is "roughly one testnet block", and that is the right answer for a node that is BEHIND:
 * waiting a block is exactly what helps. It is the wrong answer for a node that simply did not
 * answer in time - measured on prod 2026-09-19, eight reads in ten came back under 3s while the
 * node was 100% synced, so that failure clears in seconds and a retry a block later is punishment
 * for our own wobble.
 *
 * The owner met this on their phone: a card that says "Our side, not yours" and "your cooldown is
 * untouched" above a button disabled for 71 seconds. Telling someone it is our fault and locking
 * them out anyway is the part that reads badly, and it is not a wording problem.
 */
export function freshnessRetrySeconds(state: string, nodeHeight: number | null | undefined): number {
  // Our own node did not answer. Nothing about the chain is wrong and nothing needs a block to
  // pass; the next read is very likely to succeed.
  if (state === "unverifiable" && nodeHeight == null) return 5;
  // We could not verify the NETWORK's height - an independent reference is missing rather than
  // our node. It refreshes on its own cadence, so a short wait is honest but not a block.
  if (state === "unverifiable") return 20;
  // Genuinely behind: a block is what helps.
  return FRESHNESS_RETRY_SECONDS;
}

export const freshnessRetrySecondsForTest = freshnessRetrySeconds;
