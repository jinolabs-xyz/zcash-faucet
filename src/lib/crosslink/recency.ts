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

/**
 * How far behind the network tip the node may be and still pay out.
 *
 * BLOCKS, NOT A PERCENT, matching how the TAZ side's freshness gate thinks. A percent
 * hides scale: 99.9% of 362,000 blocks is still 362 blocks behind, and a transaction built
 * against a view that stale is the #172 hazard on a different chain. Two blocks is ordinary
 * propagation lag; more than that and the node has not caught up.
 */
export const MAX_SYNC_LAG_BLOCKS = 2;

/**
 * MAY WE HAND OUT cTAZ? Two independent questions, and the gate has to ask both.
 *
 * This used to take the state alone, and #322 proved that insufficient: the five states
 * describe the FINALITY view, and a node can report current rounds while being a quarter
 * synced. My own test row read READY at 23.1%. Their wallet needs the chain to spend, so
 * serving from that node would accept a claim and fail to pay, and it would look like a
 * faucet bug rather than a gate that never asked. The CTO made it a hard block on #328.
 *
 * The two questions stay separate everywhere EXCEPT here, which is the point. The panel
 * renders the state and the percent side by side, because "23% synced" and "cannot reach
 * the node" must not look alike. Only the SERVING decision needs them combined, and it is
 * combined in the one function whose name is the serving decision, so no caller can reach
 * for a weaker check by accident.
 *
 * FAILS CLOSED ON UNKNOWN. A missing height or tip refuses, exactly as cannot-verify does.
 * An unmeasured sync distance is not a short one, and defaulting either side to zero would
 * make an unreadable node look perfectly caught up.
 *
 * AND A THIRD QUESTION, ADDED AFTER PRODUCTION ANSWERED THE FIRST TWO PERFECTLY AND STILL
 * COULD NOT PAY (#409). Both questions above are about the NODE. Neither asks whether the
 * code that hands out the money can reach it, and in the container it cannot: measured from
 * inside zcash-faucet-faucet-1, the container's loopback is its own, 172.17.0.1 times out
 * because the node binds loopback only, and host.docker.internal is not defined here.
 *
 * That was known. read.ts says it in its own header - "in the container the RPC cannot work
 * at all" - and builds a file fallback so READING works. Nobody asked what PAYING would do.
 * The result was a panel showing ready and servable while every cTAZ claim died at
 * `fetch("")`, burning the user's attempt and showing them a red box.
 *
 * `source` is the honest test, and it is better than checking whether the URL is set. The
 * file can only tell us the node is WELL. Only the RPC can tell us we can REACH it, which
 * is what the payment needs, so serving is allowed exactly when the state came back over
 * the path the sender will use. Checking configuration instead would flip this to true the
 * moment someone exported CROSSLINK_RPC_URL, without a route existing - which is the same
 * trap one level down.
 */
export function canServeCtaz(
  state: CtazState,
  blocks: number | null,
  tip: number | null,
  source: "file" | "rpc" | "none",
): boolean {
  if (source !== "rpc") return false;
  if (state !== "ready") return false;
  if (blocks == null || tip == null) return false;
  // A node AHEAD of the reported tip is not behind. The tip is an estimate and can lag the
  // node by a block, so this is ordinary rather than suspicious.
  return tip - blocks <= MAX_SYNC_LAG_BLOCKS;
}
