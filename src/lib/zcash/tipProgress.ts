/**
 * Is our own node still making progress?
 *
 * The existing freeze signal compares our tip against an independent one and calls
 * a large gap frozen. That works, and it has two blind spots:
 *
 *   1. It needs the oracle. When the external tip is null we deliberately fail
 *      open (a public-endpoint outage must not take down a healthy faucet), so a
 *      genuinely stuck node is invisible for exactly as long as the oracle is.
 *   2. It is a statement about DISTANCE, not about MOTION. A node wedged at a
 *      height the network only just passed looks fine by gap and is just as stuck.
 *
 * Progress needs no second opinion: if our own tip has not moved in a long while,
 * something is wrong regardless of what any dashboard says. So the two signals are
 * complementary rather than alternatives, and freeze is the OR of them.
 *
 * Pure, like decide.ts and shieldGate.ts, so the elapsed-time branches are
 * reachable in a test by passing a clock instead of waiting twenty minutes.
 */

export interface TipSample {
  height: number;
  at: number; // epoch ms
}

export interface TipProgress {
  /** True only on positive evidence: we have an earlier sample, same height, and enough time has passed. */
  stalled: boolean;
  /** How long the tip has sat unchanged, or null when we cannot say yet. */
  stalledMs: number | null;
  /** The sample to remember for next time. */
  next: TipSample;
}

/**
 * How long our tip may sit unchanged before we call it stalled.
 *
 * Testnet targets ~75s per block but is irregular, and a quiet stretch of several
 * minutes is normal rather than alarming. 20 minutes is ~16 blocks' worth of
 * headroom: long enough that ordinary variance never trips it, short enough that a
 * wedged node is caught inside one alerting window. It also sits far above any
 * test's runtime, so a double reporting a fixed height cannot false-positive.
 */
export const TIP_STALL_MS = Number(process.env.FAUCET_TIP_STALL_MS ?? 20 * 60_000);

/**
 * @param prev the last sample we took, or null on the first observation.
 * @param height our node's tip right now.
 * @param now    epoch ms, injected so tests need not wait.
 */
export function tipProgress(
  prev: TipSample | null,
  height: number,
  now: number,
): TipProgress {
  // No history: we cannot claim a stall, and absence of evidence is not evidence.
  // This matches readiness's fail-open posture — a fresh process must not report a
  // frozen node just because it has only looked once.
  if (prev == null) {
    return { stalled: false, stalledMs: null, next: { height, at: now } };
  }

  // The tip moved: progress, and the clock restarts from this observation.
  if (height !== prev.height) {
    return { stalled: false, stalledMs: 0, next: { height, at: now } };
  }

  // Unchanged. Keep the ORIGINAL timestamp, so stalledMs measures how long it has
  // been stuck rather than the gap between the last two polls.
  const stalledMs = now - prev.at;
  return { stalled: stalledMs >= TIP_STALL_MS, stalledMs, next: prev };
}
