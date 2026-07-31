/**
 * The reserve reconciler: an interval loop that keeps the hot wallet topped up
 * without ever pausing service.
 *
 * Each tick reads the spendable balance, runs the hysteresis rule (decide.ts),
 * and — when refilling — enqueues ONE bounded refill step. The rules that keep
 * the request path unblocked:
 *
 *   - The step goes through the same serial send queue as drips, so the wallet
 *     builds one tx at a time and a refill can never select notes concurrently
 *     with a live send. FIFO means a drip waits behind at most one step.
 *   - A tick skips its step when the queue has any user traffic in it. Refill
 *     work never consumes a queue slot a person is waiting on.
 *   - At most one step is in flight; a slow step just means later ticks skip.
 *   - Balance reads stay outside the queue — deciding costs nothing.
 *
 * A failed step is logged and retried on a later tick; the loop itself never
 * dies. Singleton on globalThis to survive dev hot reloads, same pattern as
 * the send queue.
 */
import { config, ZATOSHI_PER_TAZ } from "../config.ts";
import { safeBalance } from "../zcash/send.ts";
import { getSendQueue } from "../zcash/queue.ts";
import { classifySweep, decideRefilling, initialRefilling, shouldStartStep } from "./decide.ts";
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
   * loop is BLIND, not idle — the distinction that hid #172 for sixteen hours.
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
   * Arm the loop. Called from instrumentation.ts only — status polls read
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
      const start = shouldStartStep({
        // Undecided must not act. We have not established that a refill is wanted.
        refilling: this.refilling === true,
        canAct: config.reserve.shieldCoinbase,
        stepInFlight: this.stepInFlight,
        queueDepth: getSendQueue().depth, // user traffic first, refill can wait
      });
      if (!start) return;

        // Back off a step that keeps throwing, rather than tightening a loop that
        // cannot succeed. decide.ts is untouched: the hysteresis rule is correct and
        // the problem was never the decision, it was hammering an impossible action
        // every 30 seconds and reporting nothing.
        this.ticksSinceAttempt++;
        if (!shouldAttempt(this.failedSteps, this.ticksSinceAttempt)) return;
        this.ticksSinceAttempt = 0;

      this.stepInFlight = true;
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
          this.remainingUTXOs = outcome.remainingUTXOs ?? null;

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
            return;
          }
          // A sweep that shields nothing is normal once and suspicious in a run.
          // remainingUTXOs is what separates "there is genuinely nothing here"
          // from "there is plenty and this account cannot see it" — the question
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
          // Sampled like every other repeating state here, and worded by outcome:
          // having no coinbase to shield is WAITING on this testnet, not a fault, and
          // saying "failed" every tick is how a real fault gets lost in the noise.
          if (shouldSay(this.failedSteps)) {
            const verb = outcome === "waiting" ? "cannot sweep yet" : "FAILED";
            const log = outcome === "waiting" ? console.log : console.error;
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
      failedSteps: this.failedSteps,
      lastFailure: this.lastFailure,
    };
  }
}

// globalThis so instrumentation and route bundles (separate module instances)
// share one reconciler, and dev hot reloads can't stack a second loop.
const g = globalThis as unknown as { __faucetReserve?: ReserveReconciler };

/** The singleton. Getting it is passive — only start() (instrumentation) arms it. */
export function getReserveReconciler(): ReserveReconciler {
  return (g.__faucetReserve ??= new ReserveReconciler());
}
