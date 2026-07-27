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
import { decideRefilling, shouldStartStep } from "./decide";
import { getRefiller } from "./refiller";

export interface ReserveStatus {
  targetTaz: number;
  lowTaz: number;
  refilling: boolean;
  spendableTaz: number | null;
}

class ReserveReconciler {
  private refilling = false;
  private spendableZat: bigint | null = null;
  private stepInFlight = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;

  /**
   * Arm the loop. Called from instrumentation.ts only — status polls read
   * state, they never start work. With the miner inactive this is a full
   * no-op: no timer, no balance polling, invisible until FAUCET_MINER_ACTIVE.
   * Idempotent (Next can run instrumentation more than once per process).
   */
  start(): void {
    if (!config.miner.active) return;
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
      this.refilling = decideRefilling(this.refilling, this.spendableZat, {
        lowZat: config.reserve.lowZatoshi,
        targetZat: config.reserve.targetZatoshi,
      });
      const start = shouldStartStep({
        refilling: this.refilling,
        stepInFlight: this.stepInFlight,
        queueDepth: getSendQueue().depth, // user traffic first, refill can wait
      });
      if (!start) return;

      this.stepInFlight = true;
      getSendQueue()
        .run(() => getRefiller().step())
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
