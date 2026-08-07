/**
 * What the miner is ACTUALLY doing, read from the heartbeat file the miner writes.
 *
 * What this replaces:
 *
 *   miner: { active: process.env.FAUCET_MINER_ACTIVE === "true" }
 *
 * That reports what an operator CONFIGURED. It cannot be false while the miner is
 * broken, which is not a bug in the value so much as a category error: intent was
 * being served as observation. It cost us 70 minutes of "miner on" while the miner
 * errored every 5 seconds on a stale auth cookie after zebra restarted. Same shape as
 * emptySweeps reading 0 while the refill loop threw every tick (#274).
 *
 * THE IDEA THAT MAKES THIS CATCH THAT FAILURE, and it is Infra's rather than mine: two
 * timestamps whose DIVERGENCE is the signal.
 *
 *   writtenAt        rewritten every loop iteration, INCLUDING iterations that error
 *   lastTemplateAt   advances ONLY when a template was actually fetched
 *
 * So alive-but-doing-nothing is a fresh writtenAt beside a stale lastTemplateAt. A
 * heartbeat that only proved the process was running would have rebuilt the same false
 * pass one layer down.
 *
 * THE THRESHOLDS COME FROM THE FILE, not from constants here. The writer publishes
 * staleAfterSeconds and templateStaleAfterSeconds, so if the miner's intervals are
 * retuned the thresholds move with them and this reader needs no change. A reader and
 * a writer disagreeing about a threshold is its own silent failure.
 */

/**
 * None of these is a boolean, and that is the point.
 *
 * `not-configured` and `cannot-verify` are both "we cannot see the miner", and they
 * are split because they are DIFFERENT FACTS pointing at different work. No path set
 * means nobody has wired the reader up, which is a deployment gap. A path set with
 * nothing readable at the end of it means the writer is dead or the mount is wrong,
 * which is a fault. Collapsing them sends someone to debug a miner when the actual
 * answer is an unset environment variable.
 *
 * Neither one softens into "fine". Being blind to the miner is a real deficiency
 * whichever way it happened, and the split changes WHO it points at, not how loud
 * it is.
 */
export type MinerState = "running" | "stalled" | "not-writing" | "cannot-verify" | "not-configured";

export interface Heartbeat {
  schema: number;
  writtenAt: string;
  staleAfterSeconds: number;
  templateStaleAfterSeconds: number;
  mode: "submit" | "proposal";
  lastTemplateAt: string | null;
  lastTemplateHeight: number | null;
  lastErrorStage: string | null;
  lastErrorAt: string | null;
  consecutiveErrors: number;
  /** Blocks this miner has SOLVED. The writer has emitted it since #286 and nothing
   *  read it until #408, so a miner that had fetched forty thousand templates and
   *  solved nothing looked identical to one that won a block a minute ago. */
  solvedCount: number | null;
  /** Solved AND accepted by the network. */
  submittedAccepted: number | null;
  /** Solved and REFUSED, which is a different fault and the one that looks like success
   *  at every other layer: the miner is working, and none of its work counts. */
  submittedRejected: number | null;
  /** When it last solved one, so "has ever won" can be told from "is winning". */
  lastSolvedAt: string | null;
}

export interface MinerReading {
  state: MinerState;
  /** Seconds since the file was last written, null when we could not read one. */
  beatAgoSeconds: number | null;
  /** Null before the miner has ever fetched a template, which is not the same as 0. */
  templateAgoSeconds: number | null;
  lastTemplateHeight: number | null;
  mode: "submit" | "proposal" | null;
  lastErrorStage: string | null;
  consecutiveErrors: number | null;
  /** Blocks solved. Null means the miner did not say, which is not zero: an older
   *  writer and a miner that has never won are different claims. */
  solvedCount: number | null;
  /** Of those, how many the network took, and how many it refused. */
  submittedAccepted: number | null;
  submittedRejected: number | null;
  /** Seconds since the last solve, null when it has never solved or did not say. */
  solvedAgoSeconds: number | null;
}

const NOTHING = {
  beatAgoSeconds: null,
  templateAgoSeconds: null,
  lastTemplateHeight: null,
  mode: null,
  lastErrorStage: null,
  consecutiveErrors: null,
  solvedCount: null,
  submittedAccepted: null,
  submittedRejected: null,
  solvedAgoSeconds: null,
} as const;

/** No heartbeat path configured, so this app was never asked to look. */
export const UNCONFIGURED: MinerReading = { state: "not-configured", ...NOTHING };

// Spread NOTHING rather than repeating it. The two lists had already drifted apart once
// in spirit - every new field meant remembering two places - and a cannot-verify reading
// that carried a stale count from somewhere would be worse than one that carries none.
const UNVERIFIABLE: MinerReading = { state: "cannot-verify", ...NOTHING };

/**
 * Seconds between an RFC3339 stamp and now, or null if the stamp is unusable.
 *
 * A FUTURE TIMESTAMP IS NOT FRESH. Both processes sit on one box so the clocks agree,
 * but if that ever stops being true a stamp ahead of us would produce a negative age
 * that passes every staleness test, and a broken clock would make a dead miner look
 * alive. Anything ahead of now is treated as unreadable instead.
 */
function ageSeconds(stamp: unknown, nowMs: number): number | null {
  if (typeof stamp !== "string") return null;
  const t = Date.parse(stamp);
  if (Number.isNaN(t)) return null;
  const age = (nowMs - t) / 1000;
  return age < 0 ? null : age;
}

function positiveNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Classify the parsed heartbeat. `raw` is whatever came out of the file, including
 * null when there was no file, so every not-readable path lands in one place.
 *
 * ORDER MATTERS. not-writing outranks stalled: if the file itself is stale we have no
 * grounds to believe anything inside it, so reporting on template age from a file
 * nobody is updating would be reading a claim as a measurement.
 *
 * Every unhandled shape falls to cannot-verify, which is the fail-closed direction for
 * a readout: cannot-verify never renders as healthy and never as off, because "we
 * learned nothing" and "the miner is off" are different claims.
 */
export function readingFor(raw: unknown, nowMs: number): MinerReading {
  if (raw == null || typeof raw !== "object") return UNVERIFIABLE;
  const h = raw as Partial<Heartbeat>;

  // A shape we do not know is not one to best-effort parse. Half-understanding a
  // heartbeat is exactly the kind of thing that reports healthy.
  if (h.schema !== 1) return UNVERIFIABLE;

  const staleAfter = positiveNumber(h.staleAfterSeconds);
  const templateStaleAfter = positiveNumber(h.templateStaleAfterSeconds);
  const beatAgo = ageSeconds(h.writtenAt, nowMs);
  if (staleAfter == null || templateStaleAfter == null || beatAgo == null) return UNVERIFIABLE;

  const mode = h.mode === "submit" || h.mode === "proposal" ? h.mode : null;
  const templateAgo = ageSeconds(h.lastTemplateAt, nowMs);
  const facts: Omit<MinerReading, "state"> = {
    beatAgoSeconds: beatAgo,
    templateAgoSeconds: templateAgo,
    lastTemplateHeight: typeof h.lastTemplateHeight === "number" ? h.lastTemplateHeight : null,
    mode,
    lastErrorStage: typeof h.lastErrorStage === "string" ? h.lastErrorStage : null,
    consecutiveErrors: typeof h.consecutiveErrors === "number" ? h.consecutiveErrors : null,
    // NULL IS NOT ZERO HERE, and the distinction is the whole point of the field. A
    // heartbeat written before #286 has no solvedCount, and reporting 0 would say "this
    // miner has never won anything" on no evidence - the same `balance ?? 0` shape the
    // reserve panel exists to avoid.
    solvedCount: typeof h.solvedCount === "number" ? h.solvedCount : null,
    submittedAccepted: typeof h.submittedAccepted === "number" ? h.submittedAccepted : null,
    submittedRejected: typeof h.submittedRejected === "number" ? h.submittedRejected : null,
    solvedAgoSeconds: ageSeconds(h.lastSolvedAt, nowMs),
  };

  if (beatAgo > staleAfter) return { ...facts, state: "not-writing" };

  // Null means the miner has never fetched a template. That is not "running and we
  // have no data yet", it is a miner that has never done the one thing it exists to
  // do, so it is stalled whatever else the file says.
  if (templateAgo == null || templateAgo > templateStaleAfter) return { ...facts, state: "stalled" };

  return { ...facts, state: "running" };
}

/**
 * The one field the old API exposed. Kept so existing consumers keep working, but it
 * is derived now rather than echoed from env, so it can finally be false while the
 * miner is broken. cannot-verify is NOT active: we have not established that it is.
 */
export function isActive(state: MinerState): boolean {
  return state === "running";
}
