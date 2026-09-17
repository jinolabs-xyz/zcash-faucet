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

import { config } from "../config.ts";
import { DEFAULT_NETWORK, NETWORKS, type FaucetNetwork } from "../network.ts";

/** Outcomes we can honestly classify. `unknown` is counted and never held against us. */
export type SendOutcome = "ok" | "failed" | "unknown" | "refused";

export interface SendRecord {
  outcome: SendOutcome;
  at: number;
  /**
   * Which wallet paid (#517). The log was global, so a degraded TAZ wallet refused cTAZ
   * claims. Absent on records written before this; those read as the default rather than
   * being dropped, which would shrink the sample silently.
   */
  network?: FaucetNetwork;
  /**
   * The z_sendmany reply itself was lost, so there is no opid and we do not know the wallet
   * heard us (zalletsend.ts records "no-opid"). Distinct from an unresolved opid, where the
   * wallet took the job and is probably broadcasting. #527 put both in `unknown`; only this
   * kind counts toward a verdict. Absent reads as the opid kind.
   */
  unanswered?: boolean;
}


/**
 * How many sends we need before saying anything at all: CLASSIFIABLE ones for the
 * failure-rate verdict, and any mix of unresolved and failed for the nothing-resolves
 * verdict below. Lowering it loosens both.
 *
 * Below this the verdict is `unknown` or, with nothing resolving, `degraded`, never `ok`. One failed send is not evidence of a
 * dead wallet, and on a quiet faucet it may be the only send that hour. Requiring a
 * sample is what stops this from paging on a single unlucky claim, and answering
 * `unknown` rather than `ok` is what stops a quiet faucet from vouching for a wallet
 * nobody has exercised.
 */
export const MIN_SAMPLE = 3;

/**
 * Failures alone, with nothing succeeding, that are a verdict on their own (risk
 * register II, R-18). The sample rule above needs three DECIDED sends in the window
 * and production does about nine drips a day, so a wallet that answered balances and
 * refused every send kept readiness 200, live-smoke green and the watchdog quiet for
 * hours: one stranger failed, then a second an hour later, and by the time a third
 * arrived the first had aged out. Two strangers failing in a row with no success in
 * between is not a blip about individual claims; one failure still is.
 */
export const FAIL_ALONE = 2;

/**
 * How far back we look. Long enough that a handful of claims accumulate on a quiet
 * faucet; long enough to hold MIN_SAMPLE unresolved sends spaced by the send deadline
 * (the queue is serial and a send that blew its deadline is still running, so
 * consecutive deadline unknowns are at least one deadline apart, and a ten-minute
 * window could never hold three of them at the stock 309 s: review measured unknowns
 * every 300 s reading degraded and every 301 s "too few to judge"); and as short as
 * those two allow, because the memory is how long a fault that is already fixed stays
 * reported when no send follows it.
 *
 * DERIVED FROM THE DEADLINE, because the deadline is derived from operator-settable
 * timings (ZALLET_OP_TIMEOUT_MS) and a constant would silently stop fitting the moment
 * an operator raised them past 321 s (review, round 2, measured). Fifteen minutes is
 * the floor; above it the window is (MIN_SAMPLE - 1) deadlines plus a minute. The
 * memory therefore SCALES with the deadline: past an op timeout of about 741 s the
 * window exceeds the watchdog's 30 min readiness grace, and on a quiet faucet a fault
 * fixed half an hour ago with no send since can still be reported and paged. That is
 * the trade for the rule being able to fire at all at that setting; a send that lands
 * clears it.
 */
export function windowFor(sendTaskDeadlineMs: number): number {
  return Math.max(15 * 60_000, (MIN_SAMPLE - 1) * sendTaskDeadlineMs + 60_000);
}

/** The window in force for this process: derived from the configured deadline, above. */
export const WINDOW_MS = windowFor(config.sendTaskDeadlineMs);
/** Whole minutes for the operator-facing sentence: a derived window is not a round number. */
export function windowMinutes(windowMs: number): number {
  return Math.round(windowMs / 60_000);
}

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
  /** Of `unknown`, the ones where the reply itself was lost. Reported because a degraded
   *  verdict can rest entirely on these, and `failed: 0` beside "4 of the last 5 sends
   *  failed or went unanswered" reads as a contradiction on the page. */
  unanswered: number;
  /** The wallet refused the recipient (the visitor's 400). Reported so a run of them is
   * visible, never counted: they say nothing about the wallet. */
  refused: number;
  reason: string;
}

const g = globalThis as unknown as { __faucetSendLog?: SendRecord[] };

/** On globalThis for the same reason the driver and the queue are: Next hands
 *  instrumentation and route handlers different module instances (#234). */
function log(): SendRecord[] {
  return (g.__faucetSendLog ??= []);
}

export function recordSend(
  outcome: SendOutcome,
  network: FaucetNetwork = DEFAULT_NETWORK,
  now: number = Date.now(),
  unanswered = false,
): void {
  const l = log();
  l.push({ outcome, at: now, network, unanswered });
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
export function readSendHealth(
  now: number = Date.now(),
  records: SendRecord[] = log(),
  network: FaucetNetwork = DEFAULT_NETWORK,
): SendHealth {
  // BY NETWORK (#517). A record with no network predates this and is read as the default
  // rather than dropped -- it is a send we made, and discarding it would shrink the sample
  // silently, which is worse than attributing it to the wallet it almost certainly used.
  const live = records.filter((r) => r.at >= now - WINDOW_MS && (r.network ?? DEFAULT_NETWORK) === network);
  const ok = live.filter((r) => r.outcome === "ok").length;
  const failed = live.filter((r) => r.outcome === "failed").length;
  const unknown = live.filter((r) => r.outcome === "unknown").length;
  const refused = live.filter((r) => r.outcome === "refused").length;

  // Unknowns are excluded from the denominator as well as the numerator. Including them
  // would let a run of slow sends dilute a real failure rate below the threshold, which
  // is the same mistake in the opposite direction from counting them as failures.
  // A lost reply counts; an unresolved opid still does not (#528). The second is the
  // "slow but working" case the header is about. The first is also the outcome that holds
  // the claimant's cooldown for the full day (route.ts, #88), where an outright failure
  // releases it: so a run of them has to take the wallet out of service faster than
  // failures do, not never. `unknown` keeps reporting both; only the counting splits them.
  const unanswered = live.filter((r) => r.outcome === "unknown" && r.unanswered === true).length;
  const heldBack = unknown - unanswered;
  const failing = failed + unanswered;
  // Not just "failed": a sentence calling a lost reply a failure sends an operator looking
  // for an error the wallet never sent.
  const failingWord = unanswered > 0 ? "failed or went unanswered" : "failed";

  const decided = ok + failing;
  if (decided < MIN_SAMPLE) {
    // Nothing succeeded and unresolved plus failed make a sample: the wallet is not
    // finishing sends. Judged before the sample rule, which would otherwise answer "too
    // few to judge" forever, since a wallet that never resolves never produces enough
    // decided sends. Inside this branch decided < MIN_SAMPLE, so the sum reaching it
    // means at least one unresolved send; the failed-only case (three refusals, no
    // unknowns) never gets here and is the ratio rule's, one branch down.
    if (ok === 0 && heldBack + failing >= MIN_SAMPLE) {
      return {
        state: "degraded",
        ok,
        failed,
        unknown,
        unanswered,
        refused,
        reason: `${unknown} of the last ${unknown + failed} sends never resolved and none succeeded, the wallet is not finishing sends`,
      };
    }
    // Two failures and no success (R-18): judged here too, since two decided sends
    // never reach the ratio rule. The ratio rule still owns anything with a success in
    // it, so one failure beside one success stays "too few to judge".
    if (ok === 0 && failing >= FAIL_ALONE) {
      return {
        state: "degraded",
        ok,
        failed,
        unknown,
        unanswered,
        refused,
        reason: `${failing} of the last ${failing} sends ${failingWord} and none succeeded`,
      };
    }
    return {
      state: "unknown",
      ok,
      failed,
      unknown,
      unanswered,
      refused,
      reason: `only ${decided} decided send(s) in the last ${windowMinutes(WINDOW_MS)} min, too few to judge`,
    };
  }

  if (failing / decided >= FAIL_RATIO) {
    return {
      state: "degraded",
      ok,
      failed,
      unknown,
      unanswered,
      refused,
      reason: `${failing} of the last ${decided} sends ${failingWord}`,
    };
  }

  return { state: "ok", ok, failed, unknown, unanswered, refused, reason: `${ok} of the last ${decided} sends succeeded` };
}

/** The networks this faucet actually serves. A parked network has no claimants, so its
 *  wallet cannot block serving; the day it comes back this covers it with no code change. */
export function servedNetworks(): FaucetNetwork[] {
  return config.crosslink.enabled ? [...NETWORKS] : [DEFAULT_NETWORK];
}

/**
 * The verdict for the whole faucet: degraded on ANY served network, else the primary
 * wallet's. Readiness and status must ask this rather than readSendHealth(), or the
 * default network argument silently narrows them to TAZ and a dead cTAZ wallet becomes
 * invisible to both (#517, caught in review).
 */
export function readSendHealthServed(
  now: number = Date.now(),
  records: SendRecord[] = log(),
  networks: FaucetNetwork[] = servedNetworks(),
): SendHealth {
  const each = networks.map((n) => ({ n, h: readSendHealth(now, records, n) }));
  const bad = each.find((e) => e.h.state === "degraded");
  if (!bad) return each[0].h;
  // Named when it is not the primary wallet, so an operator reading one sentence knows
  // which of two wallets to go and look at.
  return bad.n === DEFAULT_NETWORK ? bad.h : { ...bad.h, reason: `${bad.n}: ${bad.h.reason}` };
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
