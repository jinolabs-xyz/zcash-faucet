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
import { config, ZATOSHI_PER_TAZ } from "../config";
import { safeBalance } from "../zcash/send";
import { getSendQueue } from "../zcash/queue";
import { classifySweep, decideRefilling, shouldStartStep } from "./decide";
import { getRefiller } from "./refiller";

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
  /** UTXOs the backend last reported as still shieldable, when it says. */
  remainingUTXOs: number | null;
}

class ReserveReconciler {
  private refilling = false;
  private spendableZat: bigint | null = null;
  private stepInFlight = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private blindTicks = 0;
  private emptySweeps = 0;
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
        console.error(
          `[reserve] balance UNKNOWN (${this.blindTicks} consecutive tick(s)): cannot reach the wallet, ` +
            `so refill decisions are frozen at refilling=${this.refilling}. This is not an idle loop, it is a blind one.`,
        );
      } else {
        if (this.blindTicks > 0) {
          console.log(`[reserve] balance readable again after ${this.blindTicks} blind tick(s)`);
        }
        this.blindTicks = 0;
      }

      this.refilling = decideRefilling(this.refilling, this.spendableZat, {
        lowZat: config.reserve.lowZatoshi,
        targetZat: config.reserve.targetZatoshi,
      });

      // Needing to refill while forbidden to is the state that stranded 47.5 TAZ.
      // It is a legitimate configuration, so it is not an error to be fixed in
      // code, but it must never be invisible: without this line the loop reports
      // refilling=true forever and never says why nothing happens.
      if (this.refilling && !config.reserve.shieldCoinbase) {
        console.error(
          "[reserve] refill is NEEDED but shielding is not permitted (FAUCET_SHIELD_COINBASE is off), " +
            "so no coinbase will be swept and the balance cannot recover on its own.",
        );
      }
      const start = shouldStartStep({
        refilling: this.refilling,
        canAct: config.reserve.shieldCoinbase,
        stepInFlight: this.stepInFlight,
        queueDepth: getSendQueue().depth, // user traffic first, refill can wait
      });
      if (!start) return;

      this.stepInFlight = true;
      getSendQueue()
        // Same backstop as a drip (#88). A shield sweep goes through the same
        // wallet and the same async-operation polling, so a stuck one would
        // stall every queued claim behind it just as surely as a stuck send.
        .run(() => getRefiller().step(), config.sendTaskDeadlineMs)
        .then((outcome) => {
          this.remainingUTXOs = outcome.remainingUTXOs ?? null;
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
          console.error(
            `[reserve] sweep moved nothing (${this.emptySweeps} consecutive, verdict=${verdict}), ` +
              `remainingUTXOs=${outcome.remainingUTXOs ?? "not reported"}. ${because}`,
          );
        })
        .catch((err) => {
          console.error(`[reserve] refill step failed (retrying next tick): ${err instanceof Error ? err.message : err}`);
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
      refilling: this.refilling,
      spendableTaz:
        this.spendableZat === null ? null : Number(this.spendableZat) / Number(ZATOSHI_PER_TAZ),
      shieldCoinbase: config.reserve.shieldCoinbase,
      blindTicks: this.blindTicks,
      emptySweeps: this.emptySweeps,
      remainingUTXOs: this.remainingUTXOs,
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
