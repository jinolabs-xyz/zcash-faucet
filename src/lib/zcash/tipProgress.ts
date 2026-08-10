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

import { num } from "../config.ts";

export interface TipSample {
  height: number;
  at: number; // epoch ms
  /**
   * The independently-observed tip at the moment OUR tip last moved. Kept so the
   * quiet-network check below spans the whole stall window rather than the gap
   * between two polls.
   */
  externalHeight: number | null;
}

export interface TipProgress {
  /** True only on positive evidence: we have an earlier sample, same height, and enough time has passed. */
  stalled: boolean;
  /** How long the tip has sat unchanged, or null when we cannot say yet. */
  stalledMs: number | null;
  /**
   * The network appears to be quiet too: the independent tip is known and has not
   * moved either. Our tip standing still is then expected rather than a fault.
   */
  networkQuiet: boolean;
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
// num() rather than Number(): an unparseable value becomes NaN, and `elapsed >=
// NaN` is FALSE for every elapsed, so a bad env var would mean a tip wedged for a
// day reports stalled=false while stalledMs sits beside it showing 86,400,000.
// Refuse to boot instead. Found by SDE-App running it.
export const TIP_STALL_MS = num("FAUCET_TIP_STALL_MS", 20 * 60_000);

/**
 * @param prev           the last sample we took, or null on the first observation.
 * @param height         our node's tip right now.
 * @param externalHeight the independently-observed tip now, or null if unknown.
 * @param now            epoch ms, injected so tests need not wait.
 */
export function tipProgress(
  prev: TipSample | null,
  height: number,
  externalHeight: number | null,
  now: number,
): TipProgress {
  // No history: we cannot claim a stall, and absence of evidence is not evidence.
  // This matches readiness's fail-open posture - a fresh process must not report a
  // frozen node just because it has only looked once.
  if (prev == null) {
    return { stalled: false, stalledMs: null, networkQuiet: false, next: { height, at: now, externalHeight } };
  }

  // The tip moved: progress, and the clock restarts from this observation.
  if (height !== prev.height) {
    return { stalled: false, stalledMs: 0, networkQuiet: false, next: { height, at: now, externalHeight } };
  }

  // Unchanged. Keep the ORIGINAL sample, so stalledMs measures how long it has been
  // stuck rather than the gap between the last two polls, and so the comparison
  // below spans the whole window.
  const stalledMs = now - prev.at;

  // IS THE NETWORK ALSO STANDING STILL? If the independent tip has not moved since
  // our tip last did, nobody is producing blocks and our node is not at fault. A
  // stall drives frozen, and frozen drives /api/ready 503, so without this a quiet
  // testnet would take a perfectly healthy faucet offline - the exact direction
  // #170 was filed to avoid. Found by SDE-App.
  //
  // Only a KNOWN-and-unchanged external tip suppresses it. When the oracle is down
  // (null) we still report the stall, which is the whole reason a motion signal
  // exists: it must keep working when the distance check cannot.
  const networkQuiet =
    externalHeight != null && prev.externalHeight != null && externalHeight === prev.externalHeight;

  return {
    stalled: stalledMs >= TIP_STALL_MS && !networkQuiet,
    stalledMs,
    networkQuiet,
    next: prev,
  };
}
