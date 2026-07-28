/**
 * Time budget for a multi-endpoint failover loop.
 *
 * The bug this exists to stop (#89): callFirst gave every lightwalletd endpoint
 * its own fresh 6s deadline, so the real ceiling on a user-facing GET was 6s
 * times the endpoint count. Three endpoints meant an 18s hang on /api/balance,
 * and nothing in the code said so.
 *
 * Why the total is 2x the per-attempt timeout and not 1x: with a single shared
 * budget, one endpoint that hangs for the full timeout consumes everything and
 * every endpoint after it gets zero, which makes the failover list decorative
 * at exactly the moment it is supposed to earn its keep. 2x buys one genuine
 * retry and still bounds the request.
 *
 * Endpoints that fail fast do not spend the budget, so a healthy list still
 * tries every entry. The cap only bites when endpoints actually hang.
 */

/** Total budget as a multiple of the per-attempt timeout. */
export const FAILOVER_BUDGET_MULTIPLIER = 2;

export interface FailoverBudget {
  /** Deadline for the next attempt in ms, or 0 when the budget is spent. */
  next(): number;
}

/**
 * `now` is injectable so the policy is testable without sleeping through it.
 */
export function createFailoverBudget(perAttemptMs: number, now: () => number = Date.now): FailoverBudget {
  const endsAt = now() + perAttemptMs * FAILOVER_BUDGET_MULTIPLIER;
  return {
    next(): number {
      // A later attempt gets whatever is left, never more than one full
      // per-attempt slice. Clamped at 0 so the caller can treat 0 as "stop"
      // rather than passing a negative deadline to gRPC, which would abort
      // instantly and look like the endpoint refused.
      return Math.max(0, Math.min(perAttemptMs, endsAt - now()));
    },
  };
}
