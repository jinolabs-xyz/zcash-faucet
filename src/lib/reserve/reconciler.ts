/**
 * The reserve reconciler: an interval loop that keeps the hot wallet topped up
 * without ever pausing service.
 *
 * Each tick reads the spendable balance, runs the hysteresis rule (decide.ts),
 * and - when refilling - enqueues ONE bounded refill step. The rules that keep
 * the request path unblocked:
 *
 *   - The step goes through the same serial send queue as drips, so the wallet
 *     builds one tx at a time and a refill can never select notes concurrently
 *     with a live send. FIFO means a drip waits behind at most one step.
 *   - A tick skips its step when the queue has any user traffic in it. Refill
 *     work never consumes a queue slot a person is waiting on.
 *   - At most one step is in flight; a slow step just means later ticks skip.
 *   - Balance reads stay outside the queue - deciding costs nothing.
 *
 * A failed step is logged and retried on a later tick; the loop itself never
 * dies. Singleton on globalThis to survive dev hot reloads, same pattern as
 * the send queue.
 */
import { config, ZATOSHI_PER_TAZ } from "../config.ts";
import { safeBalance } from "../zcash/send.ts";
import { getSendQueue } from "../zcash/queue.ts";
import { classifySweep, decideRefilling, initialRefilling, shouldHarvest, shouldStartStep } from "./decide.ts";
import type { ShieldFreshness } from "../zcash/shieldGate.ts";
import { getRefiller } from "./refiller.ts";
import { classifyStepFailure, shouldAttempt, type StepOutcome } from "./stepFailure.ts";

export interface ReserveStatus {
  targetTaz: number;
  lowTaz: number;
  refilling: boolean;
  spendableTaz: number | null;
  /** Whether the loop is permitted to sweep existing coinbase at all. */
  shieldCoinbase: boolean;
  /**
   * Consecutive ticks where the balance could not be read. Non-zero means the
   * loop is BLIND, not idle - the distinction that hid #172 for sixteen hours.
   */
  blindTicks: number;
  /** Consecutive sweeps that found nothing to shield. */
  emptySweeps: number;
  /**
   * Consecutive ticks where a refill was needed and shielding was not permitted.
   * Counted rather than only logged, because the log line is now sampled and the
   * state must stay readable between samples.
   */
  forbiddenTicks: number;
  /**
   * Consecutive ticks where the shield gate declined to broadcast. Separate from
   * emptySweeps on purpose: this loop tried nothing, the other tried and found
   * nothing, and only one of them means the node is the problem.
   */
  shieldRefusals: number;
  /** Why the last refusal happened, so the reason is readable without the logs. */
  lastRefusal: { state: ShieldFreshness; reason: string; lag: number | null } | null;
  /** UTXOs the backend last reported as still shieldable, when it says. */
  remainingUTXOs: number | null;
  /** Consecutive sweeps that moved funds without reporting what was left. */
  movedWithoutCount: number;
  /**
   * Whether a step is ENQUEUED OR RUNNING - it is set before the send queue is asked,
   * so a step waiting behind a drip counts. That is the useful sense for both readers
   * (the tick must not start a second one, and the harness must not sample until it has
   * settled), but it is not "executing", and a panel that says so would overclaim.
   */
  stepInFlight: boolean;
  /**
   * Whether the loop is sweeping because coinbase is THERE rather than because the
   * shielded side ran low. Distinct from `refilling` on purpose: they answer
   * different questions, and folding them together would report a healthy harvest
   * as a shortage - which is the state an operator pages on.
   */
  harvesting: boolean;
  /** Seconds since the last harvest ATTEMPT; null when there has not been one. */
  harvestAgeSeconds: number | null;
  /** The count at or above which a harvest is worth a transaction. */
  harvestMinUTXOs: number;
  /** 0 means harvesting is off and only the demand-driven refill remains. */
  harvestIntervalSeconds: number;
  /**
   * Consecutive ticks where the step THREW. Separate from emptySweeps because an
   * empty sweep means we tried and there was nothing, while this means we could not
   * even ask, and a repeated throw used to reach only a log line.
   */
  failedSteps: number;
  /**
   * Why the last step threw, and whether it is a legitimate steady state. "waiting"
   * is having no coinbase to shield, normal on a testnet where we lose almost every
   * block race. "error" is anything we do not recognise.
   */
  lastFailure: { outcome: StepOutcome; reason: string } | null;
}

/**
 * Should a REPEATING state say so on this tick?
 *
 * Every repeating line in this loop was written to fire every tick on purpose,
 * because #172 was sixteen hours of a stalled loop looking exactly like an idle
 * one and silence was the bug. That reasoning is still right for the first
 * minutes and wrong forever after.
 *
 * The live case that forced this: after the recovery the operator set low 100 and
 * target 1000 so future coinbase auto-sweeps. Spendable sits at 257, which is
 * neither below low nor at target, so `refilling` HOLDS true, and every tick
 * enqueues a sweep that correctly finds nothing. That is 2,880 identical error
 * lines a day, forever, for a faucet in perfect health.
 *
 * So: say it loudly while it is news, then keep saying it at a rate an operator
 * can actually read. The COUNTERS on /api/status stay exact either way, and the
 * clearing transition is never throttled, so nothing about the state becomes
 * invisible. Only the repetition is dropped, and the line says it is sampling so
 * nobody reads a gap as a recovery.
 */
export const LOUD_TICKS = 5; // first few are news
export const SAMPLE_EVERY = 20; // then roughly every 10 minutes at the default interval
export function shouldSay(consecutive: number): boolean {
  return consecutive <= LOUD_TICKS || consecutive % SAMPLE_EVERY === 0;
}

/** Appended when a line is a sample rather than every occurrence. */
export function sampledNote(consecutive: number): string {
  return consecutive > LOUD_TICKS ? ` (sampling 1 in ${SAMPLE_EVERY}, this state is continuous)` : "";
}

class ReserveReconciler {
  // null means UNDECIDED, not "decided not to". A fresh container has no previous
  // state for decideRefilling to hold, and `false` claimed one it did not have: a
  // deploy mid-refill at 758 of 1000 landed inside the band, held the false, and
  // stopped topping up until the balance drained under the low mark. Settled by
  // initialRefilling on the first tick that can actually read a balance.
  private refilling: boolean | null = null;
  private spendableZat: bigint | null = null;
  private stepInFlight = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private blindTicks = 0;
  private emptySweeps = 0;
  private shieldRefusals = 0;
  private forbiddenTicks = 0;
  private failedSteps = 0;
  private lastFailure: { outcome: StepOutcome; reason: string } | null = null;
  private ticksSinceAttempt = 0;
  private lastRefusal: ReserveStatus["lastRefusal"] = null;
  private remainingUTXOs: number | null = null;
  /**
   * When a harvest was last ATTEMPTED, not last succeeded. The interval exists to
   * bound how often we spend a round-trip asking, and a sweep that found nothing
   * asked just as much as one that moved funds. Timing from success would retry
   * every tick forever on an empty wallet.
   */
  private lastHarvestAt: number | null = null;
  /**
   * Did the last sweep move anything? Gates the harvest fast path, which would
   * otherwise run every tick forever on coinbase that cannot be spent - the
   * routine case while blocks mature, since a fruitless sweep is not a failure
   * and gets no backoff. Starts true so a fresh process may drain a backlog it
   * inherited; the first sweep settles it either way.
   */
  private lastSweepMoved = true;
  /**
   * Consecutive sweeps that moved funds without saying what was left. Counted rather
   * than only logged, for the same reason every other state here is: the log line is
   * sampled and the state has to stay readable between samples.
   */
  private movedWithoutCount = 0;
  /** Whether the step now in flight was started by the harvest trigger. */
  private harvesting = false;

  /**
   * Arm the loop. Called from instrumentation.ts only - status polls read
   * state, they never start work. With the miner inactive this is a full
   * no-op: no timer, no balance polling, invisible until FAUCET_MINER_ACTIVE.
   * Idempotent (Next can run instrumentation more than once per process).
   */
  start(): void {
    // Arm whenever we care about the reserve at all, not only when we may move
    // funds. Observing is free and a loop that cannot act still has to be able
    // to SAY it cannot: the old early return meant no timer, no reads and no
    // output, so "switched off" and "healthy" looked identical (#172).
    if (!config.miner.active && !config.reserve.shieldCoinbase) return;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), config.reserve.checkSeconds * 1000);
    this.timer.unref(); // never keep the process alive just to top up
    void this.tick(); // first read immediately, not one interval late
  }

  /**
   * Disarm the timer. The mirror of start(), and the honest way to drop a loop: reaching
   * into the private field from outside does not typecheck, and unref() would otherwise
   * hide an orphaned reconciler still ticking against someone else's mock.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One reconcile pass. Exposed for tests; never throws. */
  async tick(): Promise<void> {
    // Reentrancy guard: a balance read slower than checkSeconds would let the
    // next interval fire into a still-running tick. Overlap is harmless (the
    // queue serializes steps anyway) but there's no point stacking reads.
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.spendableZat = await safeBalance();

      // An unreadable balance is a REPORTABLE STATE, not a quiet one. safeBalance
      // swallows the error to keep guards from hard-failing, and decideRefilling
      // then holds state on null so we never flip on an unknown. Both are right
      // on their own; composed, they used to produce no output whatsoever, so a
      // wallet that had been unreachable for sixteen hours read exactly like a
      // healthy idle loop. Say it every tick instead (#172).
      if (this.spendableZat === null) {
        this.blindTicks++;
        if (shouldSay(this.blindTicks)) {
          console.error(
            `[reserve] balance UNKNOWN (${this.blindTicks} consecutive tick(s)): cannot reach the wallet, ` +
              `so refill decisions are frozen at refilling=${this.refilling}. This is not an idle loop, it is a blind one.` +
              sampledNote(this.blindTicks),
          );
        }
      } else {
        if (this.blindTicks > 0) {
          console.log(`[reserve] balance readable again after ${this.blindTicks} blind tick(s)`);
        }
        this.blindTicks = 0;
      }

      const levels = { lowZat: config.reserve.lowZatoshi, targetZat: config.reserve.targetZatoshi };
      // Undecided until a balance is actually readable. Once settled it never returns
      // to null, so the hysteresis rule owns every tick after the first real reading.
      this.refilling =
        this.refilling === null
          ? initialRefilling(this.spendableZat, levels)
          : decideRefilling(this.refilling, this.spendableZat, levels);

      // Needing to refill while forbidden to is the state that stranded 47.5 TAZ.
      // It is a legitimate configuration, so it is not an error to be fixed in
      // code, but it must never be invisible: without this line the loop reports
      // refilling=true forever and never says why nothing happens.
      if (this.refilling && !config.reserve.shieldCoinbase) {
        this.forbiddenTicks++;
        if (shouldSay(this.forbiddenTicks)) {
          console.error(
            "[reserve] refill is NEEDED but shielding is not permitted (FAUCET_SHIELD_COINBASE is off), " +
              "so no coinbase will be swept and the balance cannot recover on its own." +
              sampledNote(this.forbiddenTicks),
          );
        }
      } else {
        this.forbiddenTicks = 0;
      }
      // Sweep because coinbase is THERE, not only because the shielded side ran
      // low. Same permission, same queue, same gate as a refill - only the reason
      // differs. See shouldHarvest for why the count is the trigger and why the
      // sweep doubles as the probe.
      const harvest = shouldHarvest({
        // Undecided must not act, harvest included. A null balance means the loop
        // has established nothing about its own reserve, and broadcasting from
        // there is #172's blind loop with money attached.
        spendableKnown: this.spendableZat !== null,
        knownRemainingUTXOs: this.remainingUTXOs,
        minUTXOs: config.reserve.harvestMinUTXOs,
        lastSweepMoved: this.lastSweepMoved,
        msSinceLastHarvest: this.lastHarvestAt === null ? null : Date.now() - this.lastHarvestAt,
        intervalMs: config.reserve.harvestIntervalSeconds * 1000,
      });
      const start = shouldStartStep({
        // Undecided must not act. We have not established that a refill is wanted.
        refilling: this.refilling === true,
        harvesting: harvest,
        canAct: config.reserve.shieldCoinbase,
        stepInFlight: this.stepInFlight,
        queueDepth: getSendQueue().depth, // user traffic first, refill can wait
      });
      if (!start) {
        // Reset before returning, or the flag keeps its previous value on every tick
        // that yields - and /api/status then reports a harvest in progress while
        // nothing is happening, which is what an operator reads during a stall.
        //
        // BUT NOT WHILE THE STEP IS STILL ON THE WIRE. The tick does not await the
        // queued step, so the NEXT tick arrives with stepInFlight true, takes this
        // branch, and used to clear the flag out from under a harvest that was still
        // running. Any shield outliving one FAUCET_RESERVE_CHECK_SECONDS hits it, and
        // proving plus operation polling routinely does: the panel flipped from
        // "shielding coinbase" back to "idle" WHILE MONEY WAS MOVING, which is the
        // exact sentence this reset was added to stop printing.
        if (!this.stepInFlight) this.harvesting = false;
        return;
      }
      // Recorded only once the tick has actually decided to run a step. Stamping it
      // at the decision above would let a tick that yields to the queue reset the
      // clock, and harvesting would then starve behind steady traffic while
      // reporting that it had just run.
      this.harvesting = harvest && this.refilling !== true;

        // Back off a step that keeps throwing, rather than tightening a loop that
        // cannot succeed. decide.ts is untouched: the hysteresis rule is correct and
        // the problem was never the decision, it was hammering an impossible action
        // every 30 seconds and reporting nothing.
        this.ticksSinceAttempt++;
        if (!shouldAttempt(this.failedSteps, this.ticksSinceAttempt)) {
          // Nothing runs this tick, so nothing is in progress. Without this the flag set
          // just above survives the whole backoff window - twenty ticks at the cap - and
          // /api/status reports a harvest running with no step behind it, the same lie
          // the yield path above was fixed to stop telling.
          this.harvesting = false;
          return;
        }
        this.ticksSinceAttempt = 0;

      this.stepInFlight = true;
      // Stamped on ATTEMPT, and only for a harvest. A refill sweep is driven by the
      // balance and must not push the harvest clock forward: if it did, a long refill
      // would look like a recent harvest and new coinbase would go unnoticed for an
      // interval after the refill ended.
      const harvestClockBefore = this.lastHarvestAt;
      if (this.harvesting) this.lastHarvestAt = Date.now();
      getSendQueue()
        // Same backstop as a drip (#88). A shield sweep goes through the same
        // wallet and the same async-operation polling, so a stuck one would
        // stall every queued claim behind it just as surely as a stuck send.
        .run(() => getRefiller().step(), config.sendTaskDeadlineMs)
        .then((outcome) => {
          // A step that returned is a step that could ask, so the failure state clears
          // here rather than only on success: without this the backoff would ratchet to
          // ten minutes and stay there for the life of the process.
          this.failedSteps = 0;
          this.lastFailure = null;
          // A REFUSAL CARRIES NO COUNT: the wallet was never asked, so it says
          // nothing about what is there. Overwriting a known 1346 with null on a
          // single gate blip erased the backlog fact and left the drain waiting out
          // a full interval with the work still queued - this file's own rule
          // ("an absence of information must not look like a fact") run backwards.
          if (!outcome.refused) {
            this.remainingUTXOs = outcome.remainingUTXOs ?? null;
            this.lastSweepMoved = outcome.moved === true;
          }

          // A refusal is handled BEFORE the empty-sweep path and never touches
          // emptySweeps, because the step did not look. Counting it would report
          // "nothing to shield" for a tick that never asked the wallet, which is
          // #174's conflation with the sign flipped and would send an operator
          // hunting the miner address while the real fault is a stale node.
          //
          // Logged every tick rather than once, same as a blind tick. This state
          // BLOCKS recovery: the loop is refilling, permitted to sweep, and still
          // moving nothing, and the whole cost of #172 was sixteen hours of that
          // being indistinguishable from an idle loop. Loud and repeated is the
          // point, one line at the transition is not.
          if (outcome.refused) {
            // AND IT CARRIES NO CLOCK, for the reason the count above is left alone: the
            // gate answered before the wallet was asked, so this tick consumed no
            // interval. Stamping it anyway meant one lag blip at the moment a harvest
            // fell due cost a full hour of not sweeping with the work still sitting there.
            this.lastHarvestAt = harvestClockBefore;
            this.shieldRefusals++;
            this.lastRefusal = outcome.refused;
            if (shouldSay(this.shieldRefusals)) {
              console.error(
                `[reserve] shield REFUSED (${this.shieldRefusals} consecutive, state=${outcome.refused.state}, ` +
                  `lag=${outcome.refused.lag ?? "unknown"}): ${outcome.refused.reason}. ` +
                  "No coinbase will be swept until this clears, so the balance cannot recover on its own." +
                  sampledNote(this.shieldRefusals),
              );
            }
            return;
          }
          if (this.shieldRefusals > 0) {
            console.log(`[reserve] shield gate cleared after ${this.shieldRefusals} refusal(s)`);
          }
          this.shieldRefusals = 0;
          this.lastRefusal = null;

          if (outcome.moved) {
            if (this.emptySweeps > 0) {
              console.log(`[reserve] sweep moved funds after ${this.emptySweeps} empty sweep(s)`);
            }
            this.emptySweeps = 0;
            // A SWEEP THAT MOVED BUT REPORTED NO COUNT IS THE SLOW DRAIN, and it was the
            // one outcome here that said nothing at all. remainingUTXOs is what the
            // backlog path reads, so without it every sweep falls back to the interval:
            // 1346 UTXOs at one batch an hour is 56 days, not the quarter of an hour the
            // docs promise. Whether this zallet returns the field is UNVERIFIED
            // (zalletRefiller.ts), and the only other evidence is a null on /api/status
            // that ALSO means "nothing left" - the not-seen-versus-cannot-say confusion
            // this tree refuses everywhere else. Sampled, because if it is true once it
            // is true every time.
            if (outcome.remainingUTXOs == null) {
              this.movedWithoutCount++;
              if (shouldSay(this.movedWithoutCount)) {
                console.error(
                  `[reserve] sweep MOVED but reported no remainingUTXOs (${this.movedWithoutCount} consecutive). ` +
                    "The backlog fast path needs that count, so the drain falls back to one batch per " +
                    "FAUCET_HARVEST_INTERVAL_SECONDS: 1346 UTXOs is 27 batches, so about 27 hours at the " +
                    "default hour rather than the quarter of an hour the backlog path would take." +
                    sampledNote(this.movedWithoutCount),
                );
              }
            } else {
              this.movedWithoutCount = 0;
            }
            return;
          }
          // A sweep that shields nothing is normal once and suspicious in a run.
          // remainingUTXOs is what separates "there is genuinely nothing here"
          // from "there is plenty and this account cannot see it" - the question
          // #172 could not answer because the value was received and discarded.
          this.emptySweeps++;
          const verdict = classifySweep(outcome);
          const because =
            verdict === "present-but-unspendable"
              ? "Coinbase EXISTS but this account cannot spend it: check the miner address is a receiver of ZALLET_ACCOUNT."
              : verdict === "nothing-visible"
                ? "The backend reported zero remaining, so nothing mature is visible to this account yet."
                : // count-not-reported: we know nothing, and saying so is the point.
                  "The backend reported NO count at all, so we cannot tell whether coinbase is waiting. " +
                  "z_shieldcoinbase's remainingUTXOs is zcashd's shape and this zallet may not return it: " +
                  "if this line repeats, the sweep has no visibility and that is a gap, not a quiet tick.";
          if (shouldSay(this.emptySweeps)) {
            console.error(
              `[reserve] sweep moved nothing (${this.emptySweeps} consecutive, verdict=${verdict}), ` +
                `remainingUTXOs=${outcome.remainingUTXOs ?? "not reported"}. ${because}` +
                sampledNote(this.emptySweeps),
            );
          }
        })
        .catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          const outcome = classifyStepFailure(reason);
          this.failedSteps++;
          this.lastFailure = { outcome, reason };
          // A THROW ENDS THE BACKLOG PATH. The .then above clears lastSweepMoved when a
          // sweep returns having moved nothing, but a step that throws never reaches it,
          // so `draining` stayed true and the backlog branch re-fired on every tick the
          // backoff allowed, indefinitely - remainingUTXOs is deliberately left alone, so
          // nothing else could clear it. The throw that does this is the routine one on
          // this box: "Insufficient balance (have 0, need 10000 including fee)" the
          // moment the mature coinbase runs out. The count is still not touched here: we
          // know the sweep did not move funds, we do not know what is left.
          this.lastSweepMoved = false;
          // Sampled like every other repeating state here, and worded by outcome:
          // having no coinbase to shield is WAITING on this testnet, not a fault, and
          // saying "failed" every tick is how a real fault gets lost in the noise.
          if (shouldSay(this.failedSteps)) {
            const verb =
              outcome === "waiting"
                ? "cannot sweep yet"
                : outcome === "resyncing"
                  ? "is waiting for the wallet to resync"
                  : "FAILED";
            const log = outcome === "error" ? console.error : console.log;
            log(
              `[reserve] refill step ${verb} (${this.failedSteps} consecutive): ${reason}` +
                sampledNote(this.failedSteps),
            );
          }
        })
        .finally(() => {
          this.stepInFlight = false;
        });
    } catch (err) {
      // safeBalance/decide can't realistically throw, but the loop must not die.
      console.error(`[reserve] tick failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.ticking = false;
    }
  }

  get status(): ReserveStatus {
    return {
      targetTaz: Number(config.reserve.targetZatoshi) / Number(ZATOSHI_PER_TAZ),
      lowTaz: Number(config.reserve.lowZatoshi) / Number(ZATOSHI_PER_TAZ),
      // The wire shape stays boolean. Undecided reports false, which is accurate about
      // what is happening (nothing) and lasts only until a balance is readable.
      refilling: this.refilling === true,
      spendableTaz:
        this.spendableZat === null ? null : Number(this.spendableZat) / Number(ZATOSHI_PER_TAZ),
      shieldCoinbase: config.reserve.shieldCoinbase,
      blindTicks: this.blindTicks,
      emptySweeps: this.emptySweeps,
      forbiddenTicks: this.forbiddenTicks,
      shieldRefusals: this.shieldRefusals,
      lastRefusal: this.lastRefusal,
      remainingUTXOs: this.remainingUTXOs,
      harvesting: this.harvesting,
      stepInFlight: this.stepInFlight,
      movedWithoutCount: this.movedWithoutCount,
      harvestAgeSeconds:
        this.lastHarvestAt === null ? null : Math.floor((Date.now() - this.lastHarvestAt) / 1000),
      harvestMinUTXOs: config.reserve.harvestMinUTXOs,
      harvestIntervalSeconds: config.reserve.harvestIntervalSeconds,
      failedSteps: this.failedSteps,
      lastFailure: this.lastFailure,
    };
  }
}

// globalThis so instrumentation and route bundles (separate module instances)
// share one reconciler, and dev hot reloads can't stack a second loop.
const g = globalThis as unknown as { __faucetReserve?: ReserveReconciler };

/** The singleton. Getting it is passive - only start() (instrumentation) arms it. */
export function getReserveReconciler(): ReserveReconciler {
  return (g.__faucetReserve ??= new ReserveReconciler());
}

/**
 * Test-only: drop the singleton so a test can start from a known state.
 *
 * Every piece of harvest state - the clock, the count, lastSweepMoved - carries from one
 * test to the next through this global, and review has twice found a test in the wiring
 * suite passing for an inherited reason rather than the one in its name. Asserting
 * preconditions catches that; it does not let a test that needs a LIVE backlog run after
 * one that leaves the backlog dead, which is a real constraint on the order and not an
 * obvious one. This gives a test the third option: start clean and build exactly the
 * state it means to exercise.
 *
 * The timer is cleared first. A dropped reconciler with a live interval keeps ticking
 * against the next test's mock, and unref() hides that by letting the process exit anyway.
 */
export function resetReserveReconcilerForTests(): void {
  g.__faucetReserve?.stop();
  delete g.__faucetReserve;
}
