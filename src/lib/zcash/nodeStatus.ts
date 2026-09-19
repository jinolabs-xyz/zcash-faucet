/**
 * Best-effort live node/wallet sync for /api/status, so the UI can honestly show
 * "preparing / X% / ready". In zallet mode we ask the wallet for getwalletstatus
 * (its view of node_tip vs its own scanned wallet_tip). If the wallet isn't up
 * yet - which is exactly the case while zebra does its first sync - this returns
 * null and the UI shows an indeterminate "bringing the node online" state.
 */
import { config, num } from "../config.ts";
import { referenceTip } from "./externalTip.ts";
import { mayBuildTransaction, readChainFreshness, type ChainGate } from "./shieldGate.ts";
import { tipProgress, type TipSample } from "./tipProgress.ts";
import { getChainIdentity } from "./chainIdentityOracle.ts";
import {
  classifyNodeStatusError,
  recordNodeStatusFailure,
  recordNodeStatusLatency,
  recordCensoredRead,
  recordRecoveredOnRetry,
  reportNodeStatusShape,
} from "./nodeStatusFailure.ts";
import type { IdentityVerdict } from "./chainIdentity.ts";

export interface NodeStatus {
  ready: boolean;
  syncPercent: number | null;
  height: number | null; // wallet-scanned height
  nodeHeight: number | null; // node tip (OUR node's self-report)
  externalHeight: number | null; // network tip per an independent source (null = couldn't verify)
  frozen: boolean; // our node has fallen far behind the real network (#170)
  /** The distance half of `frozen`: measurably more than FREEZE_BLOCKS behind an
   * independent tip. False for a motion stall, so a reader can say "N blocks behind"
   * only when N is what tripped it (R-33). */
  behind: boolean;
  /** How long our tip has sat unchanged, or null when we cannot say yet. */
  tipStalledMs: number | null;
  /** The network is not producing blocks either, so a static tip is expected. */
  networkQuiet: boolean;
  /**
   * Whether our chain view is fresh enough to BUILD a transaction - a different and
   * much tighter question than `frozen`, and deliberately not derived from it. See
   * shieldGate.ts for why they must not share a threshold: a 40-block lag produces
   * born-expired transactions while `frozen` (200) still reads false (#172).
   * Surfaced here so it is observable from /api/status; the refusal itself belongs
   * at the broadcast site.
   */
  shield: ChainGate;
  /**
   * Are we on the real chain (#249)? Three states, and cannot-verify is the common
   * one: only the rules half is wired, so this reports a missed upgrade but does not
   * yet detect a split. Diagnostic, never a gate: an unreachable explorer is not a
   * fork and must not stop the faucet serving.
   */
  chain: IdentityVerdict;
  /**
   * The freshness DECISION, not its inputs: may we build a transaction that can
   * actually confirm? Computed here by mayBuildTransaction() so the browser reads a
   * boolean and implements nothing.
   *
   * The point is rule 15 applied to a money rule. The page has to know this to hold
   * a claim instead of sending one that would expire, and it cannot import the gate
   * (shieldGate.ts reaches config and the grpc oracle, both node-only). Left to
   * compare `shield.state` itself, the client would carry a second copy of the rule,
   * and the day the rule gains a state or moves a threshold the copy diverges in
   * silence. That is the `!== "unsafe"` bug wearing a different hat.
   */
  canBuildTx: boolean;
}

// How far our node may lag the independent tip before we call it frozen. Normal
// lag is a few blocks and our node can even read slightly AHEAD of the external
// source (its aggregate poll is a little stale), so the threshold is generous.
// A genuinely frozen node diverges by hundreds to thousands and keeps growing
// (Fauzec's faucet was 12,607 behind), so this catches a real freeze without
// false-alarming on normal lag or a fast burst of blocks.
// num() rather than Number(): NaN would make `externalHeight - n > FREEZE_BLOCKS`
// false for every gap, so the 12,607-block freeze this check was written for (#170)
// would read healthy. Refuse to boot on a value we cannot parse.
const FREEZE_BLOCKS = num("FAUCET_FREEZE_BLOCKS", 200);

// Remembered across calls so the motion check has something to compare against.
// Process-local by design: a restart legitimately forgets, and a fresh process
// must not claim a stall it has not observed.
let lastTip: TipSample | null = null;

/**
 * How long to wait for our own node to answer before calling its height unknown.
 *
 * Floored at 1000ms rather than trusted: an env var set to 0, to a word, or to something
 * negative would disable the status read entirely and every claim would be refused with a
 * sentence about the node - a configuration mistake that presents as an outage.
 */
export function nodeStatusTimeoutMs(): number {
  const raw = Number(process.env.FAUCET_NODE_STATUS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 12_000;
}

/**
 * The per-attempt deadlines, in order. The owner asked for a retry and they are right that one
 * slow read should not refuse a claim - eight of ten production samples answered under 3s, so a
 * single slow one is usually a wobble rather than a state.
 *
 * TWO ATTEMPTS, NOT THREE, AND A SHARED BUDGET RATHER THAN A MULTIPLIER. Three attempts at the
 * full deadline is 36s of a visitor's time, spent to reach the same refusal - and three requests
 * to a backend that is slow BECAUSE it is loaded is how a wobble becomes an outage. The budget is
 * the ceiling either way: attempts never sum past it.
 *
 * FAST FIRST, PATIENT SECOND. The common case answers in under 3s, so the first attempt is cut
 * short at a third of the budget: a healthy faucet loses nothing, and a slow one has already
 * spent only 4s before the attempt that is actually likely to succeed. Reversing them would make
 * every visitor wait for the slow path.
 */
export type NodeReadPurpose = "claim" | "page";

/**
 * How patient to be, and it depends on WHO IS WAITING.
 *
 * A CLAIM is a person who pressed a button and expects work to happen: waiting twelve seconds
 * for TAZ is reasonable, and being refused because we gave up at four is not.
 * A PAGE is a person who has just arrived. They are owed an answer quickly, and a status card
 * that takes twelve seconds to fill reads as a broken site - so the page gives up sooner and
 * shows what it knows.
 *
 * These were one number until 2026-09-19, and raising it to fix the claim made the page slower
 * for everyone. Two different people are waiting for two different reasons.
 */
export function nodeStatusBudgetMs(purpose: NodeReadPurpose = "claim"): number {
  const budget = nodeStatusTimeoutMs();
  // A third, floored so the page still clears the common case: eight of ten production samples
  // answered under 3s, so 4s keeps the page fast AND right almost always.
  return purpose === "page" ? Math.max(4000, Math.floor(budget / 3)) : budget;
}

export function nodeStatusAttemptsMs(purpose: NodeReadPurpose = "claim"): number[] {
  const budget = nodeStatusBudgetMs(purpose);
  // THE PAGE DOES NOT RETRY. A retry is for someone who asked us to do something; a visitor
  // reading a status card is better served by a fast unknown they can act on than by a page that
  // silently takes twice as long before telling them the same thing.
  if (purpose === "page") return [budget];
  const first = Math.max(1000, Math.floor(budget / 3));
  return [first, budget - first];
}

export async function getNodeStatus(purpose: NodeReadPurpose = "claim"): Promise<NodeStatus | null> {
  if (config.sender !== "zallet") return null;
  const { endpoint, user, password } = config.zallet;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

  try {
    // Ask our own node where it thinks the tip is. This is the only network call
    // on the readiness path - the independent tip is a cached, non-blocking read
    // (see externalTip.ts) so a slow public endpoint can never slow /api/ready.
    // RETRIED, BOUNDED (owner's ask, 2026-09-19). Eight of ten production samples answered under
    // 3s, so a single slow read is usually a wobble rather than a state, and refusing a claim on
    // one of them was the outage. The budget is shared rather than multiplied - see
    // nodeStatusAttemptsMs - because three full-length attempts is 36s of a visitor's time spent
    // to reach the same refusal, and three requests to a backend that is slow BECAUSE it is
    // loaded is how a wobble becomes an outage.
    //
    // A TIMEOUT IS A CLAIM ABOUT THE NODE, and 4000ms was making it too early: "did not answer in
    // 4s" was rendered to a visitor as "we cannot tell whether a drip would confirm", which is a
    // much stronger sentence than the evidence supported. Measured: 0.9/0.9/1.4/1.9/1.9/2.4/2.8/
    // 3.0s carried a node; 4.8s and 6.7s carried null, and zebra was healthy and 100% synced
    // throughout. The owner found it from their own phone rather than from an alert.
    const res = await (async () => {
      const attempts = nodeStatusAttemptsMs(purpose);
      for (const [i, ms] of attempts.entries()) {
        // TIMED PER ATTEMPT, NOT PER CALL. With a shared budget a call that took 9s because its
        // first attempt burned 4 is a different event from one read that took 9, and averaging
        // them would hide the wobble the retry exists to absorb.
        const startedAt = Date.now();
        try {
          const answered = await fetch(endpoint, {
            method: "POST",
            headers,
            body: `{"jsonrpc":"2.0","id":"status","method":"getwalletstatus","params":[]}`,
            signal: AbortSignal.timeout(ms),
          });
          recordNodeStatusLatency(Date.now() - startedAt);
          // Throttled inside, so this is a no-op on all but one read a minute.
          reportNodeStatusShape();
          // A SECOND ATTEMPT THAT SAVED THE CALL IS A WOBBLE; BOTH FAILING IS A STATE (SDE-Infra).
          // Nothing outside this process can tell them apart - an outside sampler and the watchdog
          // both see one successful read either way - so this is the only place it can be counted.
          if (i > 0) recordRecoveredOnRetry();
          return answered;
        } catch (e) {
          // CENSORED, NOT SLOW. We gave up at our own deadline, so this read has no measured
          // duration and must never enter a latency bucket: an aborted call counted as "8-12s"
          // reads like a measurement and is a limit of our patience.
          if (classifyNodeStatusError(e) === "timeout") recordCensoredRead();
          else recordNodeStatusLatency(Date.now() - startedAt);
          // ONLY A TIMEOUT OR A TRANSPORT FAILURE IS RETRIED, and a node that ANSWERED is not -
          // whatever it answered. Re-asking a question that was already answered turns one honest
          // "no" into three requests and the same "no".
          if (i === attempts.length - 1) throw e;
        }
      }
      // Unreachable: the loop either returns or throws on its last attempt. Thrown rather than
      // returning null so a future edit to `attempts` cannot make this silently mean "no node".
      throw new Error("node status: no attempts were made");
    })();
    if (!res.ok) {
      // The wallet is up and said no. The status code is the whole of what an operator needs and
      // is safe to write; the body is not.
      recordNodeStatusFailure("http", `status ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { result?: { wallet_tip?: { height?: number }; node_tip?: { height?: number } } };
    const w = json.result?.wallet_tip?.height ?? null;
    const n = json.result?.node_tip?.height ?? null;
    if (w == null || n == null) {
      // A 200 that does not carry the two heights. Names WHICH is missing, because a wallet that
      // reports its own tip and not the node's is a different fault from one reporting neither.
      recordNodeStatusFailure("parse", `wallet_tip ${w == null ? "missing" : "present"}, node_tip ${n == null ? "missing" : "present"}`);
      return null;
    }
    const syncPercent = n > 0 ? Math.min(100, (w / n) * 100) : null;

    // Frozen only on POSITIVE evidence, from two independent signals.
    //
    // DISTANCE: the network is reachable AND our tip is far below it. A null
    // external tip means we could not verify, and we do NOT flip to frozen on that
    // - a public-endpoint outage must never take down a healthy faucet.
    //
    // THE HIGHEST NON-STALE REFERENCE, not simply the one the aggregate handed back
    // (#548). On 2026-09-15 at 13:06Z this passed a resyncing node as current for three
    // minutes because the single reference it asked was 113 blocks behind the network
    // while another source knew better and nothing consulted it. Taking the max is what
    // makes a stale source unable to vouch for a node, and it works WITHOUT knowing the
    // source was stale - which matters, because hosh publishes no timestamp and we
    // cannot know (externalTip.ts, REFERENCE_MAX_AGE_MS).
    const externalHeight = referenceTip().height;
    const behind = externalHeight != null && externalHeight - n > FREEZE_BLOCKS;

    // MOTION: our own tip has not advanced in a long time. This needs no second
    // opinion, so it still works while the oracle is down - which is exactly when
    // the distance check goes quiet. It also catches a node wedged just behind the
    // tip, which is close enough to look fine by distance and just as stuck.
    const progress = tipProgress(lastTip, n, externalHeight, Date.now());
    lastTip = progress.next;

    const frozen = behind || progress.stalled;

    const shield = readChainFreshness(n);
    const walletCaughtUp = n > 0 && w >= n - 5;
    return {
      ready: walletCaughtUp && !frozen,
      syncPercent,
      height: w,
      nodeHeight: n,
      externalHeight,
      frozen,
      behind,
      tipStalledMs: progress.stalledMs,
      networkQuiet: progress.networkQuiet,
      shield,
      chain: getChainIdentity(),
      canBuildTx: mayBuildTransaction(shield),
    };
  } catch (err) {
    // A timeout and a refused connection are not the same event and must not read as one: "the
    // wallet is slow" and "nothing is listening" send an operator to different places. The CLASS
    // only - never the endpoint or the headers, which carry RPC credentials.
    recordNodeStatusFailure(classifyNodeStatusError(err), `after ${nodeStatusBudgetMs(purpose)}ms`);
    return null;
  }
}
