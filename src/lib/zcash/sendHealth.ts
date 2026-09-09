/**
 * Did the last few drips actually go out?
 *
 * WHY THIS EXISTS. /api/ready asks whether we CAN serve by probing the things around
 * the money path: the ledger answers, the backend pings, the node is current, a balance
 * reads. Every one of those can be true while `send()` throws on every call, because
 * reading a balance and building a shielded transaction are different operations with
 * different failure modes. A wallet that crash-loops is the case that makes this
 * concrete: it is alive often enough for a balance read to land, so readiness catches it
 * up, reports 200, and every claim in between fails. The page is green and the money
 * path is dead, which is the shape this project has already been bitten by twice, at
 * #217 with the ledger and at #170 with the frozen node.
 *
 * So this remembers OUTCOMES rather than probing capability. It is the only thing in the
 * app that can tell you a drip failed, because a failed send is currently a 502 to one
 * user and a log line nobody aggregates.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the reason the counting is safe.
 * A submitted-but-unresolved send (SendOutcomeUnknownError, TaskDeadlineError) is NOT a
 * failure: the wallet holds an opid and may well have broadcast. Counting it as failure
 * would let a slow wallet trip readiness and, through the watchdog, roll back a deploy
 * that was fine. That outage-amplifier is a bug this repo has paid for once already and
 * the readiness route carries a comment about it.
 *
 * BUT A WALLET WHERE NOTHING EVER RESOLVES IS NOT FINE EITHER (risk register #9). With
 * unknowns kept out of both the numerator and the denominator, a crash-looping zallet
 * whose every send was lost (an opid the wallet forgot, or the deadline) produced no
 * decided sends at all, so this answered "too few to judge" for as long as it lasted:
 * every claim a 504, every claimant a burnt cooldown, readiness green. A crash loop
 * usually mixes the two, connection refused (failed) and a lost opid (unknown), so the
 * rule counts both: a window with NO success, at least one unresolved send, and a
 * sample's worth of unresolved-plus-failed is degraded on its own sentence. One success
 * in the window clears it, because one success is what a slow-but-working wallet
 * produces and a dead one cannot. The cost of that invariant: a zallet that starts
 * answering sends without a txid (recorded unknown while coins move) would read as not
 * finishing sends; that is a wallet regression worth a page, not routine.
 *
 * Deliberately in memory and per-process. It is a health signal about the process doing
 * the sending, not a ledger, and persisting it would raise a retention question for data
 * that stops being true the moment the wallet is restarted.
 */

/** Outcomes we can honestly classify. `unknown` is counted and never held against us. */
export type SendOutcome = "ok" | "failed" | "unknown";

export interface SendRecord {
  outcome: SendOutcome;
  at: number;
}

/**
 * How far back we look. Long enough that a handful of claims accumulate on a quiet
 * faucet, short enough that a fault fixed half an hour ago is not still reported as
 * current. AND long enough to hold MIN_SAMPLE unresolved sends spaced by the send
 * deadline: the queue is serial and a send that blew its 309 s deadline is still
 * running, so consecutive deadline unknowns are at least 309 s apart, and a ten-minute
 * window could never hold three of them. Review measured it: unknowns every 300 s read
 * degraded, every 301 s read "too few to judge". (MIN_SAMPLE - 1) * deadline must fit,
 * with room; sendHealth.test.ts pins that against the stock deadline.
 */
export const WINDOW_MS = 15 * 60_000;

/**
 * How many sends we need before saying anything at all: CLASSIFIABLE ones for the
 * failure-rate verdict, and any mix of unresolved and failed for the nothing-resolves
 * verdict below. Lowering it loosens both.
 *
 * Below this the verdict is `unknown`, never `ok`. One failed send is not evidence of a
 * dead wallet, and on a quiet faucet it may be the only send that hour. Requiring a
 * sample is what stops this from paging on a single unlucky claim, and answering
 * `unknown` rather than `ok` is what stops a quiet faucet from vouching for a wallet
 * nobody has exercised.
 */
export const MIN_SAMPLE = 3;

/**
 * The share of recent sends that may fail before the money path is called broken.
 *
 * Not zero. A single failure among many is ordinary: a recipient address that the
 * wallet refuses, a note-selection race, a one-off timeout. Half is the point where
 * "some claims are failing" stops being noise about individual claims and becomes a
 * statement about the wallet.
 */
export const FAIL_RATIO = 0.5;

export type SendHealthState = "ok" | "degraded" | "unknown";

export interface SendHealth {
  state: SendHealthState;
  ok: number;
  failed: number;
  /** Submitted but unresolved. Reported so an operator can see them, never counted against. */
  unknown: number;
  reason: string;
}

const g = globalThis as unknown as { __faucetSendLog?: SendRecord[] };

/** On globalThis for the same reason the driver and the queue are: Next hands
 *  instrumentation and route handlers different module instances (#234). */
function log(): SendRecord[] {
  return (g.__faucetSendLog ??= []);
}

export function recordSend(outcome: SendOutcome, now: number = Date.now()): void {
  const l = log();
  l.push({ outcome, at: now });
  // Trim on write so nothing grows without bound in a long-lived process. Bounded by
  // time rather than count, because a burst of claims inside the window is exactly the
  // sample this wants to keep.
  const cut = now - WINDOW_MS;
  while (l.length && l[0].at < cut) l.shift();
}

/**
 * Classify the window. Pure given the log, so every verdict is reachable in a test
 * without a wallet, a network, or a clock.
 */
export function readSendHealth(now: number = Date.now(), records: SendRecord[] = log()): SendHealth {
  const live = records.filter((r) => r.at >= now - WINDOW_MS);
  const ok = live.filter((r) => r.outcome === "ok").length;
  const failed = live.filter((r) => r.outcome === "failed").length;
  const unknown = live.filter((r) => r.outcome === "unknown").length;

  // Unknowns are excluded from the denominator as well as the numerator. Including them
  // would let a run of slow sends dilute a real failure rate below the threshold, which
  // is the same mistake in the opposite direction from counting them as failures.
  const decided = ok + failed;
  if (decided < MIN_SAMPLE) {
    // Nothing succeeded, at least one send was left unresolved, and unresolved plus
    // failed make a sample: the wallet is not finishing sends. Judged before the sample
    // rule, which would otherwise answer "too few to judge" forever, since a wallet that
    // never resolves never produces enough decided sends. The failed-only case (three
    // refusals, no unknowns) is the ratio rule's, one branch down.
    if (ok === 0 && unknown > 0 && unknown + failed >= MIN_SAMPLE) {
      return {
        state: "degraded",
        ok,
        failed,
        unknown,
        reason: `${unknown} of the last ${unknown + failed} sends never resolved and none succeeded, the wallet is not finishing sends`,
      };
    }
    return {
      state: "unknown",
      ok,
      failed,
      unknown,
      reason: `only ${decided} decided send(s) in the last ${WINDOW_MS / 60_000} min, too few to judge`,
    };
  }

  if (failed / decided >= FAIL_RATIO) {
    return {
      state: "degraded",
      ok,
      failed,
      unknown,
      reason: `${failed} of the last ${decided} sends failed`,
    };
  }

  return { state: "ok", ok, failed, unknown, reason: `${ok} of the last ${decided} sends succeeded` };
}

/**
 * Only a DEFINITE verdict blocks. `unknown` never 503s, matching how the ledger probe is
 * treated one check above it in the readiness route: an absent answer must not be handed
 * the power to fail a deploy.
 */
export function sendHealthBlocksServing(h: SendHealth): boolean {
  return h.state === "degraded";
}

/** Test seam. Module state would otherwise leak between cases. */
export function resetSendHealth(): void {
  g.__faucetSendLog = [];
}
