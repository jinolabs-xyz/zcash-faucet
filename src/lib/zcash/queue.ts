/**
 * Serial FIFO queue for sends.
 *
 * Why sends must be serialized (not run concurrently):
 *   - The faucet is ONE hot wallet. Two sends building transactions at the same
 *     time would select the same notes → double-spend / conflicting txs.
 *   - A real WebZjs send generates a zk-proof (CPU + hundreds of MB). Running
 *     several at once OOMs a small (512 MB) instance.
 *
 * So the front door stays concurrent (validate, Turnstile, atomic reserve), but
 * the send itself is funnelled through here: strictly one at a time, in the
 * order requests arrived. Callers await their turn and get their own result.
 *
 * `maxPending` bounds the backlog so a surge doesn't queue unbounded work (and
 * make the 20th person wait forever) — past it we reject fast with "busy".
 */
import { config } from "../config";

export class QueueFullError extends Error {
  constructor() {
    super("Faucet is busy — too many sends queued. Try again in a moment.");
    this.name = "QueueFullError";
  }
}

class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly maxPending: number) {}

  /** Tasks currently waiting or running. */
  get depth(): number {
    return this.pending;
  }

  /** Enqueue a task; resolves with its result once it runs (FIFO, one at a time). */
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maxPending) return Promise.reject(new QueueFullError());
    this.pending++;

    // Chain onto the tail so tasks execute strictly in enqueue order. The tail
    // is advanced with errors swallowed so one failed send can't break the chain.
    const result = this.tail.then(() => task());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pending--;
    });
  }
}

const g = globalThis as unknown as { __faucetSendQueue?: SerialQueue };
export function getSendQueue(): SerialQueue {
  return (g.__faucetSendQueue ??= new SerialQueue(config.sendQueueMaxPending));
}
