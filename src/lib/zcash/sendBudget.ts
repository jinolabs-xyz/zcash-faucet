/**
 * How long a single queued send can legitimately take, and therefore where the
 * queue's backstop deadline belongs (#88).
 *
 * This is arithmetic and nothing else so config.ts can import it without
 * dragging in the sender, and so the numbers can be asserted in a test.
 *
 * WHY A DERIVED NUMBER AND NOT A LITERAL
 * The queue deadline is a backstop for a send that hangs in a way the sender's
 * OWN bounds failed to catch. It must never be the thing that fires first. A
 * hardcoded value would silently start firing the moment an operator raised
 * ZALLET_OP_TIMEOUT_MS, converting normal slow sends into unknown outcomes,
 * which is the most expensive false positive available on a money path: the
 * claimant eats a full cooldown for a drip that actually landed.
 */

/**
 * Status-poll attempts inside one pollStatus call. Lives here rather than in
 * zalletsend.ts because the worst-case arithmetic below depends on it, and two
 * copies would drift.
 */
export const POLL_RETRIES = 3;

export interface SenderTimings {
  opTimeoutMs: number;
  rpcTimeoutMs: number;
  pollMs: number;
}

/**
 * Worst case for ZalletSender.send, walking the code path it actually takes.
 *
 *   head        unlockIfNeeded + z_sendmany            2 x rpcTimeoutMs
 *   poll loop   bounded by opTimeoutMs, BUT the deadline is only checked after
 *               pollStatus returns, so the final iteration can overrun by one
 *               whole pollStatus: POLL_RETRIES x rpcTimeoutMs of attempts plus
 *               its 1x, 2x, 3x pollMs backoff sleeps
 *   tail        z_getoperationresult                   1 x rpcTimeoutMs
 *
 * With defaults (op 180s, rpc 15s, poll 1.5s) that is 279s, not the 195s you
 * get from opTimeoutMs + rpcTimeoutMs. The gap is the poll-loop overrun, and
 * missing it would put the backstop inside the legitimate range.
 */
export function senderWorstCaseMs(z: SenderTimings): number {
  const rpcCalls = 3 + POLL_RETRIES; // 2 head, 1 tail, POLL_RETRIES in the overrun
  const backoffSleeps = (POLL_RETRIES * (POLL_RETRIES + 1)) / 2; // 1x + 2x + 3x pollMs
  return z.opTimeoutMs + rpcCalls * z.rpcTimeoutMs + backoffSleeps * z.pollMs;
}

/**
 * Margin on top of the worst case. Building a shielded proof is CPU heavy and
 * hundreds of megabytes, so the event loop can stall for a while under GC on a
 * small box, and the timer fires late rather than never.
 *
 * Asymmetric on purpose: firing late costs one caller a longer wait, firing
 * early costs someone a cooldown for coins they did receive.
 */
export const DEADLINE_MARGIN_MS = 30_000;

/** Default for SEND_TASK_DEADLINE_MS. */
export function defaultTaskDeadlineMs(z: SenderTimings): number {
  return senderWorstCaseMs(z) + DEADLINE_MARGIN_MS;
}
