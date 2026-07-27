/**
 * Hysteresis decision for the refill loop: start when spendable drops below
 * the low-water mark, stop once it reaches the target, and in between keep
 * doing whatever we were doing. Two thresholds instead of one so the balance
 * hovering around a single line can't flap the miner on and off every tick.
 *
 * Pure function, no imports — the reconciler owns the state, this owns the rule.
 */

export interface ReserveLevels {
  /** Start refilling below this. */
  lowZat: bigint;
  /** Stop refilling at or above this. Must be > lowZat. */
  targetZat: bigint;
}

/**
 * Next value of `refilling` given the current spendable balance.
 * `spendableZat` is null when the wallet can't report a balance (backend down,
 * still syncing) — hold the current state rather than reacting to a blind spot.
 */
export function decideRefilling(
  refilling: boolean,
  spendableZat: bigint | null,
  levels: ReserveLevels,
): boolean {
  if (spendableZat === null) return refilling;
  if (spendableZat < levels.lowZat) return true;
  if (spendableZat >= levels.targetZat) return false;
  return refilling;
}
