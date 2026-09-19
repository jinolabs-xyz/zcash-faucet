/**
 * WHY THE NODE STATUS READ FAILED, WHICH NOTHING USED TO RECORD.
 *
 * `getNodeStatus()` collapses every failure into `null`: a 4-second timeout, a refused connection,
 * a non-200, malformed JSON and a missing field all return the same value and write nothing
 * anywhere. Readiness gate 3 fires on exactly that null, so the chain is
 *
 *     the read fails for SOME reason  ->  null  ->  "node status unknown"  ->  503  ->  not ready
 *
 * and the reason is discarded one function earlier than the sentence that names the symptom.
 * SDE-Infra hit this on 2026-09-19: production was flapping in and out of readiness, roughly one
 * read in three, and nothing on the box or in the logs could distinguish a busy wallet from a
 * refused connection - not because nobody dug, but because the information did not exist.
 *
 * It is L54 one step worse. A check that reports by silence cannot be told apart from one that
 * never ran; this reported a FAILURE by silence.
 *
 * WHAT IS RECORDED AND WHAT IS NOT. The CLASS, and a count per class. Never the endpoint, never a
 * header, never the body - this call carries wallet RPC credentials and a log line is the easiest
 * place in the system to leak one.
 *
 * THROTTLED, BECAUSE THE FAILURE MODE IS FLAPPING. A node failing one read in three at a 30-second
 * poll would write thousands of identical lines a day and train a reader to skip them, which is the
 * "guard somebody disables" failure we keep filing. So: the FIRST of each class is written
 * immediately, because the first one is the news; after that at most one line a minute per class,
 * carrying how many happened since the last line. The count is the interesting number - "how
 * often" - and it is what a rate is computed from.
 */

/** The four ways the read can fail, kept apart because they want different answers. */
export type NodeStatusFailureKind =
  /** The 4s AbortSignal fired. The wallet is reachable and did not answer in time. */
  | "timeout"
  /** The wallet answered with a non-200. It is up and refusing or erroring. */
  | "http"
  /** It answered 200 and the body was not what we asked for - bad JSON, or no heights in it. */
  | "parse"
  /** Nothing answered: refused, DNS, socket closed. Distinct from a timeout on purpose. */
  | "network";

export const NODE_STATUS_FAILURE_KINDS: readonly NodeStatusFailureKind[] = ["timeout", "http", "parse", "network"];

export interface NodeStatusFailureCounts {
  timeout: number;
  http: number;
  parse: number;
  network: number;
}

const counts: NodeStatusFailureCounts = { timeout: 0, http: 0, parse: 0, network: 0 };
/** When each class was last written to the log, and how many it has had since. */
const lastLoggedAt: Record<NodeStatusFailureKind, number> = { timeout: 0, http: 0, parse: 0, network: 0 };
const sinceLastLog: NodeStatusFailureCounts = { timeout: 0, http: 0, parse: 0, network: 0 };

const THROTTLE_MS = 60_000;

/**
 * Which class a thrown value belongs to.
 *
 * `AbortSignal.timeout()` rejects with a DOMException named TimeoutError; an aborted fetch in
 * other runtimes uses AbortError. Both mean the same thing here and neither is a network refusal,
 * which is why they are not lumped in with it - "the wallet is slow" and "nothing is listening"
 * send an operator to different places.
 */
export function classifyNodeStatusError(err: unknown): NodeStatusFailureKind {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name?: unknown }).name) : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  // A body that is not JSON throws a SyntaxError from res.json(), which is a parse failure and not
  // a network one - the wallet answered, it just did not answer this question.
  if (name === "SyntaxError") return "parse";
  return "network";
}

/**
 * Record one failure and, when it is worth saying out loud, say it.
 *
 * Returns the line it wrote, or null when throttled - so a test can assert the throttle rather
 * than infer it from a spy on the console.
 */
export function recordNodeStatusFailure(
  kind: NodeStatusFailureKind,
  detail: string | null,
  now: number = Date.now(),
  write: (line: string) => void = (line) => console.warn(line),
): string | null {
  counts[kind] += 1;
  sinceLastLog[kind] += 1;
  const first = counts[kind] === 1;
  const due = now - lastLoggedAt[kind] >= THROTTLE_MS;
  if (!first && !due) return null;
  const n = sinceLastLog[kind];
  const suffix = detail ? ` (${detail})` : "";
  const line = first
    ? `[node-status] read failed: ${kind}${suffix}. Readiness answers "node status unknown" while this is happening.`
    : `[node-status] read failed: ${kind}${suffix}. ${n} since the last line, ${counts[kind]} since start.`;
  lastLoggedAt[kind] = now;
  sinceLastLog[kind] = 0;
  write(line);
  return line;
}

/** A copy, so a caller cannot edit the counters by holding them. */
export function nodeStatusFailureCounts(): NodeStatusFailureCounts {
  return { ...counts };
}

/** Test seam. Nothing in the app calls this. */
export function resetNodeStatusFailures(): void {
  for (const k of NODE_STATUS_FAILURE_KINDS) {
    counts[k] = 0;
    lastLoggedAt[k] = 0;
    sinceLastLog[k] = 0;
  }
  resetNodeStatusLatency();
  lastShapeAt = 0;
  everReported = false;
  countingSince = 0;
  failedAttempts = 0;
  fastestFailureMs = null;
}

/* ── how long the reads take, which is a different question from why they fail ──────────────── */

/**
 * THE SUB-TIMEOUT DISTRIBUTION, AND IT IS ONLY THAT.
 *
 * RIGHT-CENSORED AT OUR OWN ABORT, which is the most important sentence here (@SDE-Research).
 * This counter lives inside the app and the app hangs up at `nodeStatusTimeoutMs()`. So the top
 * bucket can never fill - not because no call takes that long, but BECAUSE WE NEVER WAIT THAT
 * LONG. An empty "12s and over" would read exactly like good news and mean "we never looked",
 * which is L54 in the instrument L54 was written about.
 *
 * So an aborted read is NOT a bucket. It is counted separately as `censoredAt`, named for the
 * deadline that cut it off, and the only honest reading of these numbers is "the shape of the
 * reads that came back". Establishing an upper bound needs a probe whose timeout is longer than
 * ours, from outside this process.
 *
 * BOUNDARIES SIT ON THE DEADLINES, NOT NEAR THEM (@SDE-Research, from n=1017 on production). A
 * bucket that STRADDLES a timeout can never answer "did this call cross the line", which is the
 * only question anyone asks of it - an earlier draft had a 3-5s bucket straddling the old 4s abort
 * and would have made exactly that unanswerable. 4s is the old budget, 12s the new one, and the
 * bottom of the range is fine-grained because the healthy mode is 2-21ms: a single "under 1s"
 * bucket throws the entire normal distribution away, and a median drifting from 20ms to 200ms is a
 * 10x degradation nobody would see.
 */
export const LATENCY_BUCKET_EDGES_MS = [50, 250, 1_000, 2_000, 4_000, 8_000, 12_000] as const;

const LATENCY_LABELS = ["<50ms", "50-250ms", "250ms-1s", "1-2s", "2-4s", "4-8s", "8-12s", ">=12s"] as const;

const latency = new Array<number>(LATENCY_LABELS.length).fill(0);
/** Aborted by OUR deadline. A known-unknown, kept out of the buckets so nobody averages over it. */
let censored = 0;
/** The single worst reading that came back. A histogram loses it, and it often explains an outage. */
let slowestMs = 0;
/**
 * A first attempt that failed and a second that SAVED it (@SDE-Infra). #688 retries on a shared
 * budget, so this is the wobble-versus-state distinction - and it cannot be made from outside at
 * all: an outside sampler and the watchdog both see one successful read either way. The app is the
 * only place it can be counted.
 */
let recoveredOnRetry = 0;

function bucketOf(ms: number): number {
  for (let i = 0; i < LATENCY_BUCKET_EDGES_MS.length; i++) if (ms < LATENCY_BUCKET_EDGES_MS[i]) return i;
  return LATENCY_LABELS.length - 1;
}

/** One read that CAME BACK, however it then turned out. Aborted reads go to recordCensoredRead. */
export function recordNodeStatusLatency(ms: number, now: number = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  if (countingSince === 0) countingSince = now;
  latency[bucketOf(ms)] += 1;
  if (ms > slowestMs) slowestMs = ms;
}

/** One read WE gave up on, named for the deadline that cut it off. Never a latency bucket. */
/**
 * An attempt that FAILED without reaching our deadline - refused, reset, or answered with an error
 * status. It has a duration, but it is not a measurement of how long the wallet takes to answer,
 * so it must not enter a latency bucket: a node refusing in 3ms would otherwise pile into <50ms
 * and read as the fastest node we have ever seen.
 */
export function recordFailedAttempt(ms: number, now: number = Date.now()): void {
  if (countingSince === 0) countingSince = now;
  failedAttempts += 1;
  if (!Number.isFinite(ms) || ms < 0) return;
  if (fastestFailureMs === null || ms < fastestFailureMs) fastestFailureMs = ms;
}

export function recordCensoredRead(now: number = Date.now()): void {
  if (countingSince === 0) countingSince = now;
  censored += 1;
}

/** One read that only succeeded because the second attempt did. */
export function recordRecoveredOnRetry(): void {
  recoveredOnRetry += 1;
}

export interface NodeStatusLatencyView {
  buckets: Record<string, number>;
  /** Reads we abandoned at our own deadline. NOT a bucket - see the note above. */
  censoredAtOurDeadline: number;
  slowestObservedMs: number;
  recoveredOnRetry: number;
  /** Attempts that failed BELOW our deadline. Never a bucket - they measure no answer. */
  failedAttempts: number;
  fastestFailureMs: number | null;
}

export function nodeStatusLatency(): NodeStatusLatencyView {
  const buckets: Record<string, number> = {};
  LATENCY_LABELS.forEach((label, i) => { buckets[label] = latency[i]; });
  return {
    buckets,
    censoredAtOurDeadline: censored,
    slowestObservedMs: slowestMs,
    recoveredOnRetry,
    failedAttempts,
    fastestFailureMs,
  };
}

export function resetNodeStatusLatency(): void {
  latency.fill(0);
  censored = 0;
  slowestMs = 0;
  recoveredOnRetry = 0;
}

/**
 * SAY THE SHAPE OUT LOUD, PERIODICALLY, BECAUSE A COUNTER NOBODY READS IS NOT AN INSTRUMENT.
 *
 * The failure classes reach the journal on their own throttle. Until this, the LATENCY half did
 * not: it accumulated where only an ops-token reader could ever see it, which makes the most
 * important number in the file a footnote (@SDE-Research).
 *
 * AND recoveredOnRetry IS THE HEADLINE, not a detail on the failure path. #688 raised the budget
 * AND added a retry in one change, so afterwards "the nulls went away" has two possible meanings
 * that are indistinguishable from outside this process: the calls got fast enough, or a second
 * attempt is rescuing a first that still fails. One says zallet recovered; the other says we are
 * retrying past a problem that is still there. This counter is the only thing in the system that
 * separates them, so it is printed first and by name.
 *
 * Throttled on the same interval as the classes, and only when something has actually happened -
 * a line every minute saying nothing is the noise that trains a reader to skip the ones that
 * matter.
 */
export function reportNodeStatusShape(
  now: number = Date.now(),
  write: (line: string) => void = (line) => console.warn(line),
): string | null {
  const v = nodeStatusLatency();
  const reads = Object.values(v.buckets).reduce((a, b) => a + b, 0);
  // NOTHING TO SAY means nothing HAPPENED, not "nothing worked". A process whose every attempt was
  // refused has plenty to say and no successful read to say it with - staying quiet there is the
  // reporter going silent exactly when it is most worth reading.
  if (reads === 0 && v.censoredAtOurDeadline === 0 && v.failedAttempts === 0) return null;
  // THE FIRST ONE ALWAYS SPEAKS, same rule as the failure classes: at now=0 against an unset
  // lastShapeAt the throttle would swallow the very first report, and a process that restarts
  // often would then never say its shape at all.
  if (everReported && now - lastShapeAt < THROTTLE_MS) return null;
  everReported = true;
  lastShapeAt = now;
  const shape = Object.entries(v.buckets)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label}=${n}`)
    .join(" ");
  // CENSORED IS NAMED AS CENSORED, never folded into the buckets: it is how many reads WE gave up
  // on, not how long they took, and an empty top bucket beside it must not read as good news.
  // THE WINDOW, BECAUSE A COUNTER WITH NO STATED SCOPE IS A FACT ABOUT A PROCESS AND NOT ABOUT THE
  // SYSTEM (L49, @SDE-Research). "recovered 12, censored 3" is a claim about an unnamed period and
  // cannot be compared to anything; "in the last 11m" can. These are cumulative since this process
  // first saw a read, which a restart resets - so the duration is the only honest framing.
  const overMs = Math.max(0, now - countingSince);
  const over = overMs >= 60_000 ? `${Math.round(overMs / 60_000)}m` : `${Math.round(overMs / 1000)}s`;
  // RECOVERED AND CENSORED ALWAYS TOGETHER, ON THIS LINE, whatever their values. They are the
  // success and failure halves of the same mitigation: recovered 50 / censored 0 means the retry
  // is working, recovered 50 / censored 40 means it is papering, and one number alone cannot tell
  // those apart. Printing either without the other is L45's first question.
  // A FAILURE THAT CAME BACK FAST IS NOT A FAST READ. It has a duration and no answer, so it is
  // counted here and never bucketed - otherwise a node refusing in 3ms lands in <50ms and the
  // histogram reports the fastest wallet we have ever run. `fastest-failure` is the one App needs:
  // a second attempt dying instantly is what a null at 4.27s on a 4s-then-8s ladder is made of.
  const failures =
    v.failedAttempts > 0
      ? `failed-attempts=${v.failedAttempts} fastest-failure=${v.fastestFailureMs}ms `
      : `failed-attempts=0 `;
  // NOTHING RETURNED IS NOT "0ms". With reads=0 a slowest of 0ms reads as "every read was
  // instant" - the good-news spelling of no data, which is the whole fault this line exists to
  // stop telling.
  const slowest = reads === 0 ? "none" : `${v.slowestObservedMs}ms`;
  const line =
    `[node-status] shape over ${over}: recovered-on-retry=${v.recoveredOnRetry} ` +
    `censored=${v.censoredAtOurDeadline} ${failures}slowest-returned=${slowest} ` +
    `reads=${reads} ${shape}`;
  write(line);
  return line;
}

let lastShapeAt = 0;
let everReported = false;
/** When this process first observed a read. The shape line is meaningless without it (L49). */
let countingSince = 0;
let failedAttempts = 0;
let fastestFailureMs: number | null = null;
