/**
 * Hysteresis decision for the refill loop: start when spendable drops below
 * the low-water mark, stop once it reaches the target, and in between keep
 * doing whatever we were doing. Two thresholds instead of one so the balance
 * hovering around a single line can't flap the miner on and off every tick.
 *
 * Pure functions with no imports. The reconciler owns the state, this owns the
 * rules: when to be refilling (decideRefilling), whether a given tick may
 * enqueue a refill step (shouldStartStep), and what an empty sweep actually
 * means (classifySweep).
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

/**
 * Whether this tick may enqueue a refill step. Refill yields to everything:
 * we must actually be refilling, be permitted to move funds at all, have no
 * step already in flight, and no user traffic waiting on the send queue.
 *
 * `canAct` matters for honesty as much as for cost. Enqueueing a step we are
 * forbidden to complete burns a queue slot for a guaranteed no-op, and it makes
 * the loop report a run of empty sweeps as though it had tried and found nothing
 * when it never tried at all. That is the same "verdict we never established"
 * mistake #172 was filed about, so it is not one to re-introduce while fixing it.
 */
export function shouldStartStep(opts: {
  refilling: boolean;
  canAct: boolean;
  stepInFlight: boolean;
  queueDepth: number;
}): boolean {
  return opts.refilling && opts.canAct && !opts.stepInFlight && opts.queueDepth === 0;
}

/**
 * What a finished sweep actually tells us.
 *
 * A shield that moves nothing is normal once and a symptom in a run, and until
 * #172 the two were indistinguishable: the code returned early on "no opid" and
 * said nothing, so a permanently unspendable pile of coinbase looked exactly
 * like a quiet tick with nothing to do. The backend reports `remainingUTXOs`
 * alongside the opid, and that number is what separates the cases.
 *
 *   refused                   the step DECLINED to broadcast, so nothing was
 *                             asked and nothing was learned about what is there
 *   moved                     funds actually moved
 *   nothing-visible           no opid and the backend REPORTED zero remaining:
 *                             genuinely empty, or nothing mature yet
 *   present-but-unspendable   no opid but UTXOs remain, so the coinbase exists
 *                             and this account cannot spend it. That is the
 *                             47.5 TAZ shape: wrong account, not empty.
 *   count-not-reported        no opid and no figure at all, so we know nothing
 *                             about what is there
 *
 * That last one is its own verdict rather than being folded into
 * nothing-visible, and the distinction is the point of the whole function.
 * `{ opid, remainingUTXOs }` is zcashd's z_shieldcoinbase shape and zallet is a
 * rewrite, so whether it reports the figure at all is UNVERIFIED. Defaulting a
 * missing count to "nothing is there" would restore exactly the #172 blindness
 * this replaced, with tests passing over the top of it. A fact and an absence of
 * information are different things and the caller must be able to see which it has.
 *
 * `refused` is on the same footing and is checked first. A refusal carries no
 * count because the wallet was never asked, so every other branch here would read
 * it as a statement about coinbase: without this it lands on count-not-reported
 * and points an operator at the miner address while the actual fault is a stale
 * chain view. Keeping the function total over StepOutcome is what stops that,
 * rather than relying on every caller to check `refused` before calling.
 */
export type SweepVerdict =
  | "refused"
  | "moved"
  | "nothing-visible"
  | "present-but-unspendable"
  | "count-not-reported";

export function classifySweep(outcome: {
  moved: boolean;
  refused?: unknown;
  remainingUTXOs?: number;
}): SweepVerdict {
  if (outcome.refused) return "refused";
  if (outcome.moved) return "moved";
  if (typeof outcome.remainingUTXOs !== "number") return "count-not-reported";
  if (outcome.remainingUTXOs > 0) return "present-but-unspendable";
  return "nothing-visible";
}
