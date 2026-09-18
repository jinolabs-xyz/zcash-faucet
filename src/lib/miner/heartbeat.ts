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
/**
 * "waiting" (#5 of the 2026-09-08 risk register): the miner is alive and has CHOSEN not to
 * fetch templates because the node is behind its own estimate of the network by more than
 * MINER_MAX_LAG. Before the guard existed this miner spent an afternoon extending a private
 * fork with its own blocks. Waiting is neither stalled nor running: nothing is wrong with
 * the miner, and it is not mining. It is never active.
 */
export type MinerState = "running" | "waiting" | "stalled" | "not-writing" | "cannot-verify" | "not-configured";

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
  /** How far behind its own estimate the node was at the miner's last check. */
  nodeLag: number | null;
  /** Set while the sync guard holds the miner back; null the moment it mines again. */
  waitingSince: string | null;
  /** Why: "behind" (lag over MINER_MAX_LAG) or "no-peers" (an isolated node). */
  waitingReason: string | null;
  /** Why the last submitted block was refused, as a FIXED TOKEN and never zebra's text
   *  (#666). The miner's raw errors are the transport's and can carry an RPC URL with
   *  credentials in its userinfo - the rule lastErrorStage already follows. */
  lastRejectReason: string | null;
  /** Solves DROPPED because the tip moved while we were working (#660). Without it an
   *  abandoned solve and a genuine no-solution-in-window are identical from outside. */
  abandonedCount: number | null;
  /** When the last one was dropped, so a total can be told from a total that stopped. */
  lastAbandonedAt: string | null;
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
  /** Blocks the node was behind its own estimate at the last check; null when the
   *  writer predates the sync guard or has not checked yet. */
  nodeLag: number | null;
  /** Seconds the sync guard has been holding the miner back; null when it is not. */
  waitingAgoSeconds: number | null;
  /** "behind" or "no-peers" while waiting; anything else the writer says is kept as text. */
  waitingReason: string | null;
  /**
   * OPERATOR ONLY. NEVER SPREAD INTO THE PUBLIC RESPONSE - see `route.ts`, which
   * destructures this off before it spreads the reading.
   *
   * WHY IT IS A NESTED OBJECT AND NOT THREE MORE FLAT FIELDS, which is the whole design:
   * `route.ts` publishes the reading with `...minerReading`, so reading a field and
   * PUBLISHING it are the same action. Three flat fields would reach every visitor the
   * moment they were parsed, and the only thing stopping that would be a person
   * remembering. Nested, the leak requires DELETING a line rather than forgetting one,
   * and a row can assert the public response does not carry these keys.
   */
  operator: MinerOperatorReading;
}

/**
 * The half of the reading that may be published WITHOUT the ops token.
 *
 * A NAMED FUNCTION RATHER THAN A DESTRUCTURE AT THE CALL SITE, so that "what the public
 * may see" is a thing with a test rather than a habit in a route handler. The test drives
 * it with a REAL reject reason and asserts the string does not survive serialisation -
 * which a key-absence check at the wire level cannot do while the test environment has no
 * heartbeat and every operator value is null. An assertion that has only ever seen null
 * has not been shown to withhold a secret.
 */
export function publicMinerView(r: MinerReading): Omit<MinerReading, "operator"> {
  const { operator: _operator, ...rest } = r;
  void _operator;
  return rest;
}

/** The half of the reading that stays behind the ops token. */
export interface MinerOperatorReading {
  /** A fixed token, never the node's message. Null when nothing has been refused. */
  lastRejectReason: string | null;
  /** Solves dropped because the tip moved. Null is "the writer did not say", not zero. */
  abandonedCount: number | null;
  /** Seconds since the last drop - a total beside a recency, which is as close to a rate
   *  as this can honestly get without inventing a window. */
  abandonedAgoSeconds: number | null;
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
  nodeLag: null,
  waitingAgoSeconds: null,
  waitingReason: null,
  operator: { lastRejectReason: null, abandonedCount: null, abandonedAgoSeconds: null },
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
    nodeLag: typeof h.nodeLag === "number" && Number.isFinite(h.nodeLag) && h.nodeLag >= 0 ? h.nodeLag : null,
    waitingAgoSeconds: ageSeconds(h.waitingSince, nowMs),
    waitingReason: typeof h.waitingReason === "string" && h.waitingReason ? h.waitingReason : null,
    operator: {
      // A fixed token from a known writer is still not a thing to publish, so this is
      // parsed the same careful way and then kept behind the token by route.ts.
      lastRejectReason: typeof h.lastRejectReason === "string" && h.lastRejectReason ? h.lastRejectReason : null,
      // NULL IS NOT ZERO, for the same reason it is not zero on solvedCount: a heartbeat
      // written before #666 has no abandonedCount, and reporting 0 would say "this watcher
      // has never dropped a solve" on no evidence - which is the exact claim an operator
      // would read it for.
      abandonedCount: typeof h.abandonedCount === "number" ? h.abandonedCount : null,
      abandonedAgoSeconds: ageSeconds(h.lastAbandonedAt, nowMs),
    },
  };

  if (beatAgo > staleAfter) return { ...facts, state: "not-writing" };

  // A fresh file that says the miner is holding back on purpose. Judged BEFORE the
  // template age, because a waiting miner has a stale lastTemplateAt by construction and
  // calling that stalled would send someone to fix a miner that is behaving. It is judged
  // AFTER not-writing for the same reason as everything else: a stale file testifies to
  // nothing, including this.
  //
  // AND ONLY BESIDE A CLEAN ERROR COUNT. The writer clears the wait on any RPC error, but
  // an older writer might not, and the watchdog applies the same rule: a wait beside a
  // non-zero consecutiveErrors is a wedged connection wearing a calm label, and both
  // readers must call that the stall it is, or the panel says "waiting" while the
  // watchdog restarts it.
  // `=== 0`, not `?? 0`: a wait with NO error count at all is not honoured here, and the
  // watchdog treats a missing count as unreadable rather than zero, so the two agree.
  if (facts.waitingAgoSeconds != null && facts.consecutiveErrors === 0) return { ...facts, state: "waiting" };

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
