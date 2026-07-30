/**
 * What to do when a refill step THROWS.
 *
 * The gap this closes, found by the CTO reading the box rather than the code: the loop
 * had been failing every tick since it was armed, with
 *
 *   [reserve] refill step failed (retrying next tick): zallet RPC z_shieldcoinbase:
 *   Failed to propose shielding transaction: Insufficient balance (have 0, need 10000
 *   including fee) (code -4)
 *
 * while /api/status read refilling=true, emptySweeps=0, shieldRefusals=0, blindTicks=0.
 * Every counter clean while the loop errored continuously. classifySweep counts the
 * empty sweep, the gate counts the refusal, safeBalance counts the blind tick, and a
 * step that threw was counted by NOTHING. It only reached a log line.
 *
 * An empty sweep and a failed step must not read the same: one means we tried and
 * there was nothing, the other means we could not even ask.
 *
 * AND MOST OF THESE ARE NOT FAILURES. On this testnet, having no mined coinbase to
 * shield is the normal steady state, because we lose nearly every block race. A loop
 * that cannot sweep because there is nothing to sweep is WAITING, not broken, and
 * calling it broken every 30 seconds is how a real failure gets lost in the noise.
 */

/**
 * `waiting` is a legitimate steady state. `error` is not.
 *
 * Classified from the wallet's message, which is the fragile part and is why the
 * DEFAULT IS `error`: an unrecognised message is treated as a real failure, so a new
 * kind of breakage arrives loud rather than being quietly absorbed into "waiting".
 * Adding a pattern here is a deliberate act, and mis-classifying toward silence is the
 * failure mode this whole change exists to remove.
 */
export type StepOutcome = "waiting" | "error";

/**
 * zallet reports "nothing to shield" as an insufficient-balance error on the
 * transparent pool. The `have 0` form is the one we have actually observed. The
 * broader "Insufficient balance" is included because the same condition with dust
 * present reports a non-zero `have`, and that is still nothing-to-sweep rather than a
 * fault.
 */
const NOTHING_TO_SHIELD = [/insufficient balance/i, /no (spendable )?(coinbase|utxos?) /i];

export function classifyStepFailure(message: string): StepOutcome {
  return NOTHING_TO_SHIELD.some((re) => re.test(message)) ? "waiting" : "error";
}

/**
 * Ticks to skip before trying again, given how many consecutive attempts have failed.
 *
 * Backing off rather than tightening, per the CTO: a loop that cannot succeed should
 * not hammer, and the fix is not to stop wanting to refill. decide.ts stays untouched,
 * because the hysteresis rule is correct and the problem was never the decision.
 *
 * Doubling from 1, capped at 20 ticks. At the default 30s that is a floor of 30s and a
 * ceiling of 10 minutes, which is frequent enough that a newly mined coinbase is swept
 * within ten minutes and rare enough that the log stops being a wall.
 */
export const MAX_BACKOFF_TICKS = 20;

export function backoffTicks(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(MAX_BACKOFF_TICKS, 2 ** (consecutiveFailures - 1));
}

/**
 * Should this tick attempt a step at all?
 *
 * `ticksSinceLastAttempt` counts ticks since the last ATTEMPT rather than since the
 * last failure, so the backoff measures what it claims to and a tick skipped for any
 * other reason does not reset it.
 */
export function shouldAttempt(consecutiveFailures: number, ticksSinceLastAttempt: number): boolean {
  return ticksSinceLastAttempt >= backoffTicks(consecutiveFailures);
}
