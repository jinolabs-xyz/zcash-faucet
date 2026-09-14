/**
 * How long the browser's proof-of-work will probably take, from what the worker has
 * measured so far (risk register II, R-38).
 *
 * The solve is a lottery: every hash has a 2^-difficulty chance, independent of the
 * ones before it, so the expected number of hashes is 2^difficulty however many have
 * already been tried. That is why this returns the whole expected duration at the
 * measured rate and not "remaining" work: there is no remaining, only the same odds.
 * The page says "usually about" for the same reason.
 */
export interface PowProgress {
  difficulty: number;
  /** Hashes tried so far, as the worker reports them. */
  hashes: number;
  /** Milliseconds the worker has been running. */
  ms: number;
}

/** Hashes the worker reports before a rate is worth trusting (its first progress tick). */
export const POW_MIN_SAMPLE = 8192;

/** Expected seconds for the whole solve at the measured rate, or null before there is a rate. */
export function powEstimateSeconds(p: PowProgress): number | null {
  if (!(p.hashes >= POW_MIN_SAMPLE) || !(p.ms > 0) || !(p.difficulty >= 0)) return null;
  const perMs = p.hashes / p.ms;
  return Math.pow(2, p.difficulty) / perMs / 1000;
}

/** "about 3 s", "about 40 s", "about 2 min": coarse on purpose, an estimate is not a clock. */
export function powEstimateText(seconds: number | null): string {
  if (seconds == null) return "measuring";
  if (seconds < 1) return "under a second";
  if (seconds < 10) return `about ${Math.round(seconds)} s`;
  // 57.5 s and up rounds to "60 s" in fives, which is a minute; say so.
  if (seconds < 57.5) return `about ${Math.round(seconds / 5) * 5} s`;
  return `about ${Math.max(1, Math.round(seconds / 60))} min`;
}
