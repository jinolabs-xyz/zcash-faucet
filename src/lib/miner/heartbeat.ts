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

/** None of these is a boolean, and that is the point. */
export type MinerState = "running" | "stalled" | "not-writing" | "cannot-verify";

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
}

const UNVERIFIABLE: MinerReading = {
  state: "cannot-verify",
  beatAgoSeconds: null,
  templateAgoSeconds: null,
  lastTemplateHeight: null,
  mode: null,
  lastErrorStage: null,
  consecutiveErrors: null,
};

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
