/**
 * Serial FIFO queue for sends.
 *
 * Why sends must be serialized (not run concurrently):
 *   - The faucet is ONE hot wallet. Two sends building transactions at the same
 *     time would select the same notes → double-spend / conflicting txs.
 *   - A real send builds and broadcasts one tx against the wallet's UTXOs;
 *     serializing avoids two sends racing on the same inputs. (And a shielded
 *     send would generate a zk-proof - CPU + hundreds of MB - which you never
 *     want several of at once on a small instance.)
 *
 * So the front door stays concurrent (validate, Turnstile, atomic reserve), but
 * the send itself is funnelled through here: strictly one at a time, in the
 * order requests arrived. Callers await their turn and get their own result.
 *
 * `maxPending` bounds the backlog so a surge doesn't queue unbounded work (and
 * make the 20th person wait forever) - past it we reject fast with "busy".
 *
 * `maxPending` bounds HOW MANY wait. It says nothing about how long any one task
 * may hold the wallet, so a single task that never settles stalls every drip
 * behind it indefinitely. That is what the per-task deadline in run() is for
 * (#88), and it does less than it looks like it does: see the comments there.
 */
// .ts extension for node --test resolution, same pattern as pow.ts.
import { config } from "../config.ts";

export class QueueFullError extends Error {
  constructor() {
    super("Faucet is busy: too many sends queued. Try again in a moment.");
    this.name = "QueueFullError";
  }
}

/**
 * A task outran its deadline. AMBIGUOUS, never a failure: the task is still
 * running and may still broadcast, so callers must treat this the same way they
 * treat SendOutcomeUnknownError and must not release a claim on it.
 */
export class TaskDeadlineError extends Error {
  readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(`Send did not settle within ${deadlineMs}ms. Its outcome is unknown.`);
    this.name = "TaskDeadlineError";
    this.deadlineMs = deadlineMs;
  }
}

class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  // Plain field, not a constructor parameter property: node --test runs on
  // type stripping, which only erases types and cannot rewrite that sugar.
  private readonly maxPending: number;

  constructor(maxPending: number) {
    this.maxPending = maxPending;
  }

  /** Tasks currently waiting or running. */
  get depth(): number {
    return this.pending;
  }

  /**
   * Enqueue a task; resolves with its result once it runs (FIFO, one at a time).
   *
   * `deadlineMs` (0 disables) bounds how long the CALLER waits, and nothing
   * else. Read the comments below before changing any of this: the obvious
   * version of a deadline here is worse than the stall it fixes.
   */
  run<T>(task: () => Promise<T>, deadlineMs = 0): Promise<T> {
    if (this.pending >= this.maxPending) return Promise.reject(new QueueFullError());
    this.pending++;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let armDeadline = () => {};
    const expired =
      deadlineMs > 0
        ? new Promise<never>((_, reject) => {
            // Armed when the task STARTS, not when it was enqueued. Time spent
            // waiting behind other sends is not this task's fault, and charging
            // it for the backlog would make a busy queue fail every send at the
            // back of it.
            armDeadline = () => {
              timer = setTimeout(() => reject(new TaskDeadlineError(deadlineMs)), deadlineMs);
            };
          })
        : null;

    // The real work. Chain onto the tail so tasks execute strictly in enqueue
    // order. The tail is advanced with errors swallowed so one failed send can't
    // break the chain.
    const work = this.tail.then(() => {
      armDeadline();
      return task();
    });

    // Serialization and accounting both follow `work`, NEVER the raced promise.
    //
    // JavaScript has no cancellation. A task that blew its deadline is still
    // running and still holds the wallet, so freeing the slot at deadline time
    // would let the next send start building against the same notes, which is
    // the exact double-spend this queue exists to prevent. `depth` keeps
    // counting it for the same reason: the wallet really is still busy.
    const settle = () => {
      if (timer) clearTimeout(timer);
      this.pending--;
    };
    this.tail = work.then(settle, settle);

    // The caller gets an early answer. Losing this race does not stop the work,
    // which is why the error means "unknown" and not "did not happen".
    return expired ? Promise.race([work, expired]) : work;
  }
}

const g = globalThis as unknown as { __faucetSendQueue?: SerialQueue; __ctazSendQueue?: SerialQueue };
export function getSendQueue(): SerialQueue {
  return (g.__faucetSendQueue ??= new SerialQueue(config.sendQueueMaxPending));
}

/**
 * cTAZ gets its OWN queue, because this one exists to protect a specific wallet.
 *
 * The invariant above is "one transaction touches the single hot wallet at a time",
 * and cTAZ does not touch it: their node pays out of its own mining wallet, picks its
 * own notes, and already has a queue of its own that answers "too busy". Sharing ours
 * would serialise two independent resources, so a ten-second shielded proof on the TAZ
 * side would hold up a cTAZ drip that needed nothing from us, and a burst of TAZ
 * claims would fill the backlog and tell cTAZ callers the faucet was busy while the
 * cTAZ path sat idle. Reporting a queue someone is not in is the part that decided it.
 *
 * Still a serial queue rather than no queue: their side dedupes a pending address and
 * caps at 16, so firing concurrently at it just converts our load into their refusals.
 */
export function getCtazSendQueue(): SerialQueue {
  return (g.__ctazSendQueue ??= new SerialQueue(config.sendQueueMaxPending));
}
