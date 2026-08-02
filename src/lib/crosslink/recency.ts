/**
 * Is the Crosslink node current enough to hand out cTAZ?
 *
 * `get_tfl_recency_status` is a better readiness primitive than anything the TAZ side
 * has. Our node cannot tell us it has fallen behind, which is why the TAZ gate compares
 * our tip against an independent source (#171). This one reports the FINALIZER view:
 * the round we are on, the round we have locked, and how each finalizer has voted. A
 * node that is behind the finality layer says so in its own answer.
 *
 * Shapes here are observed, from the spike on `spike/crosslink-headless`, on a node
 * joined to the live feature net. Fields the spike did not observe are not invented.
 *
 * Pure, so every verdict is reachable in a test without a node, a network, or a chain.
 */

/** Not a boolean, for the same reason the miner readout is not. */
export type CtazState =
  | "ready"          // TFL activated, the answer is fresh, and rounds are keeping up
  | "behind"         // activated, but we are lagging the round we have locked
  | "stale"          // the node answered, but about a moment too long ago to act on
  | "not-activated"  // TFL is not on for this node yet, so there is no finality view
  | "cannot-verify"; // no readable answer, which is not the same as a bad one

export interface RecencyStatus {
  now_utc: number;
  my_height: number;
  my_round: number;
  my_locked_round: number;
  finalizer_statuses: unknown[];
}

export interface CtazReading {
  state: CtazState;
  height: number | null;
  /** Rounds between what we have seen and what we have locked. */
  roundLag: number | null;
  /** Seconds between the node's own clock reading and ours. */
  ageSeconds: number | null;
  finalizers: number | null;
}

const UNVERIFIABLE: CtazReading = {
  state: "cannot-verify",
  height: null,
  roundLag: null,
  ageSeconds: null,
  finalizers: null,
};

/**
 * How stale an answer may be before it stops describing now. Their chain spaces blocks
 * about 25 seconds apart, so 120 is roughly five blocks: long enough that a slow reply
 * or a clock a second out does not flip the gate, short enough that a wedged node is
 * caught within a couple of blocks.
 */
export const MAX_AGE_SECONDS = 120;

/**
 * Rounds we may trail our own locked round by. Zero would flap on every normal round
 * transition, which is the mistake the reserve hysteresis exists to avoid.
 */
export const MAX_ROUND_LAG = 2;

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Classify a `get_tfl_recency_status` reply. `raw` is whatever came back, including null
 * when the call failed, so every not-readable path lands in one place.
 *
 * A FUTURE `now_utc` IS NOT FRESH. Their node's clock and ours are different machines,
 * and a reply stamped ahead of us would otherwise produce a negative age that passes
 * every staleness test. Same rule the miner heartbeat follows.
 */
export function readingFor(raw: unknown, nowMs: number): CtazReading {
  if (raw == null || typeof raw !== "object") return UNVERIFIABLE;
  const r = raw as Partial<RecencyStatus>;

  const nowUtc = finite(r.now_utc);
  const height = finite(r.my_height);
  const round = finite(r.my_round);
  const locked = finite(r.my_locked_round);
  if (nowUtc == null || height == null || round == null || locked == null) return UNVERIFIABLE;

  const age = Math.floor(nowMs / 1000) - nowUtc;
  if (age < 0) return UNVERIFIABLE;

  const finalizers = Array.isArray(r.finalizer_statuses) ? r.finalizer_statuses.length : null;
  const roundLag = round - locked;
  const facts = { height, roundLag, ageSeconds: age, finalizers };

  // Staleness outranks lag: if the answer is too old we have no grounds to believe the
  // rounds in it either, and reporting on a lag from a reply nobody is refreshing would
  // be reading a claim as a measurement.
  if (age > MAX_AGE_SECONDS) return { ...facts, state: "stale" };
  // A negative lag means locked is ahead of seen, which their node should not report.
  // Unexplained rather than bad, so it is cannot-verify rather than behind.
  if (roundLag < 0) return { ...UNVERIFIABLE, height, ageSeconds: age, finalizers };
  if (roundLag > MAX_ROUND_LAG) return { ...facts, state: "behind" };
  // No finalizers means no finality view at all, whatever the rounds say.
  if (finalizers === 0) return { ...facts, state: "not-activated" };
  return { ...facts, state: "ready" };
}

/** TFL off is its own answer, distinct from an unreadable one. */
export function notActivated(): CtazReading {
  return { ...UNVERIFIABLE, state: "not-activated" };
}

/** Only one state may hand out cTAZ. cannot-verify never does. */
export function canServeCtaz(state: CtazState): boolean {
  return state === "ready";
}
