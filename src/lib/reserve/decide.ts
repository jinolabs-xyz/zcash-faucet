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
 * still syncing) - hold the current state rather than reacting to a blind spot.
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
 * The FIRST value of `refilling`, for a process that has no previous state.
 *
 * decideRefilling is right and is not what this changes. Its middle branch returns
 * the previous decision, which is what hysteresis means, and a freshly started
 * container has no previous decision. It had `false`, which is not "we decided not
 * to" but "we have not decided yet", and the two were indistinguishable.
 *
 * What that cost: the loop was refilling toward 1000, a deploy restarted the
 * container, spendable sat at 758 inside the band, and `decideRefilling(false, 758)`
 * held false. The refill silently stopped partway and would not resume until the
 * balance fell all the way back under the low mark. Every deploy did this.
 *
 * `null` means undecided, and it is returned while the balance is unreadable rather
 * than guessing from a blind spot. That keeps the same rule the rest of the loop
 * follows: not-seen and known-to-be-zero are different, and only a real reading may
 * settle the question.
 *
 * INSIDE THE BAND WE RESUME. That direction is a choice and worth defending: the
 * band is where hysteresis needs history and we have none, so one of the two answers
 * has to be picked blind. Picking "not refilling" strands the faucet partway up with
 * no way back until it drains below low, and an empty faucet is the user-visible
 * failure. Picking "refilling" costs at most some sweeps of our own coinbase, which
 * is a self-transfer, and it stops at the target on the next tick anyway.
 */
export function initialRefilling(spendableZat: bigint | null, levels: ReserveLevels): boolean | null {
  if (spendableZat === null) return null;
  return spendableZat < levels.targetZat;
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
  /**
   * The harvest trigger (shouldHarvest). Optional so every existing caller and
   * test keeps its meaning: absent is "not harvesting", which is what the loop
   * did before there was such a thing.
   *
   * It is an OR rather than a second code path because everything after the
   * decision is identical - the same bounded step, the same queue, the same
   * gate. Only the reason for starting differs, and that difference belongs in
   * the two predicates, not in a duplicated branch.
   */
  harvesting?: boolean;
  canAct: boolean;
  stepInFlight: boolean;
  queueDepth: number;
}): boolean {
  const wanted = opts.refilling || opts.harvesting === true;
  return wanted && opts.canAct && !opts.stepInFlight && opts.queueDepth === 0;
}

/**
 * Whether to sweep transparent coinbase because it is THERE, independent of how
 * much is shielded.
 *
 * decideRefilling answers "are we short?". This answers "is there a harvest
 * waiting?", and the faucet needs both: the refill rule shields what we spend
 * and never touches what we mine, so on a box that mines continuously the
 * transparent side only grows. Live, 2026-09-10: 1778 TAZ and 1346 coinbase
 * UTXOs stranded behind a trigger that had not fired since July, while the
 * shielded side sat comfortably above its low-water mark the whole time.
 *
 * TWO REASONS TO SWEEP, and they are not the same reason:
 *
 *   backlog   the last sweep reported at least `minUTXOs` still there, so there
 *             is known work. Fire on the next tick rather than waiting out the
 *             interval, or draining 1346 UTXOs at one batch per hour takes a
 *             day and a half.
 *   probe     nothing is known and the interval has passed. While idle we
 *             cannot see new coinbase arrive - remainingUTXOs only updates when
 *             a sweep reports it - so the sweep IS the probe: z_shieldcoinbase
 *             shields a batch and says what is left, answering both questions
 *             for one round-trip.
 *
 * `knownRemainingUTXOs` is null when the backend did not report a count, which is
 * the count-not-reported case classifySweep exists to keep distinct. Null is not
 * zero here either: it falls through to the interval rather than being read as
 * "nothing to do", because an absence of information must not look like a fact.
 *
 * An interval of 0 disables harvesting outright, backlog included. That is the
 * only way back to demand-only behaviour, and it is one knob rather than two so
 * "is harvesting on?" has a single answer.
 */
export function shouldHarvest(opts: {
  knownRemainingUTXOs: number | null;
  minUTXOs: number;
  /** Milliseconds since the last harvest attempt; null when there has never been one. */
  msSinceLastHarvest: number | null;
  intervalMs: number;
}): boolean {
  if (opts.intervalMs <= 0) return false;
  if (opts.knownRemainingUTXOs !== null && opts.knownRemainingUTXOs >= opts.minUTXOs) return true;
  return opts.msSinceLastHarvest === null || opts.msSinceLastHarvest >= opts.intervalMs;
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
