/**
 * The node's status, read off the request path and served from memory.
 *
 * WHY. `/api/status` builds its payload with a `Promise.all` over three backend reads, so the
 * SLOWEST one gates all of them: a height read that most visitors never look at was holding the
 * balance, the reserve, the miner and the drip count. Measured on production 2026-09-19 by
 * SDE-Research, window-matched over 29.5 minutes: the page's single-attempt 4s read refused
 * 32 of 284 (11.27%), and the distribution of successful reads has a mode at 2-3s with a tail to
 * ~10s. So the figure the card is FOR was waiting seconds on a figure it is not for, and one time
 * in nine waited and got nothing.
 *
 * SAME SHAPE AS crosslink/cache.ts, and for the same reason it gives: an expensive read with a bad
 * distribution does not belong on a request path. That file is the precedent; this is that pattern
 * applied to the wallet's height read.
 *
 * ON globalThis, NOT MODULE STATE. Next hands instrumentation and route handlers different module
 * instances (#241, and db/index.ts documents the same trap), so module-level state warmed in one
 * place is invisible in the other.
 *
 * TWO DELIBERATE DIFFERENCES FROM THE cTAZ CACHE, both stated so the divergence is a choice rather
 * than a drift:
 *   1. NO BACKGROUND TIMER. That cache runs an interval from instrumentation; this one refreshes
 *      LAZILY, when a read finds the entry stale. The wallet is the component that is struggling,
 *      and a timer asks it a question every N seconds whether or not anybody is looking. Lazy means
 *      an idle faucet costs the wallet nothing, and a busy one still asks at most once per window.
 *   2. IT KEEPS THE PAGE LADDER. The read stays `purpose: "page"` - one 4s attempt. Moving it to
 *      the retrying ladder would raise its success rate (0.35% vs 11.27% refused, same window) and
 *      costs a visitor nothing now that it is off the request path - but the failure counters are
 *      keyed by purpose, and feeding page-driven refreshes into the claim line would make that
 *      counter a number about two different callers again. That is the exact fault L57 is about and
 *      it wants a third scope in the recorder, not a quiet reuse of an existing one. Noted as a
 *      follow-up rather than smuggled in here.
 *
 * A CACHE NOBODY REFRESHES MUST AGE OUT. Past MAX_AGE_MS this reports null - "we cannot say" -
 * which is exactly what the page rendered before, rather than a reading old enough to be a
 * different chain state wearing a current timestamp.
 */
import { getNodeStatus, type NodeStatus } from "./nodeStatus.ts";
import { readChainFreshness, mayBuildTransaction } from "./shieldGate.ts";

/**
 * How stale a reading may be before a read triggers a refresh behind it.
 *
 * STRICTLY BELOW THE PAGE POLL, AND THAT IS THE WHOLE POINT OF THE NUMBER.
 *
 * It was 4000 - exactly the page's poll (`page.tsx`, `setInterval(load, 4000)`) - and the test here
 * is `age > REFRESH_AFTER_MS`, strictly greater. A lone viewer's poll arrives at an age of about
 * 4000, which does NOT trigger, so the refresh landed on every SECOND poll and the served reading
 * could be two polls plus a read old. The comment this replaces claimed "never more than one poll
 * behind", which was false by a factor of two (@CTO, #706 red-team).
 *
 * Half the poll means every poll finds the entry stale and refreshes behind the response, so the
 * true bound is ONE POLL PLUS ONE READ - which is what the row asserts and what this comment now
 * says. Equality is the trap: any value equal to the caller's period leaves the trigger to
 * scheduler jitter, and jitter is not a bound.
 *
 * The load reduction is unchanged and is per-PROCESS: the read used to happen once per visitor per
 * poll, and happens once per window however many are looking.
 */
const REFRESH_AFTER_MS = 2_000;

/**
 * Past this, the cache is not an answer.
 *
 * DELIBERATELY TIGHT, AND IT COSTS THE CACHE ITS BRIDGING. A longer window would ride over more
 * failed reads, but `ready` and `frozen` are VERDICTS a visitor acts on, and a stale TRUE is the
 * dangerous direction: a ready-looking page, a visitor who pays proof-of-work, and then
 * `/api/faucet` - which does its own fresh read - refuses them. That is #457 through a different
 * door, and the cache would widen its window from one 4s poll to whatever this number is
 * (@SDE-Research, shooting at this design before it was code).
 *
 * 15s is two refresh cycles plus slack, and under four page polls. The main benefit of this module
 * - that the visitor never WAITS on the wallet - does not depend on the window at all; only the
 * bridging does. So the window buys the smaller benefit and is priced for the larger risk.
 */
export const NODE_STATUS_MAX_AGE_MS = 15_000;

interface Cell {
  status: NodeStatus | null;
  /** When `status` was READ, not when it was served. 0 means nothing has ever been read. */
  at: number;
  inflight: Promise<void> | null;
}

const g = globalThis as unknown as { __nodeStatusCache?: Cell };

function cell(): Cell {
  if (!g.__nodeStatusCache) g.__nodeStatusCache = { status: null, at: 0, inflight: null };
  return g.__nodeStatusCache;
}

function refresh(): Promise<void> {
  const c = cell();
  // ONE IN FLIGHT AT A TIME. A slow wallet must not have refreshes stacked behind it - that is how
  // a wobble becomes an outage, and it is the same argument as the page's own in-flight guard
  // (#699), one layer down. The in-flight promise is kept rather than discarded so a COLD read can
  // wait on it briefly instead of starting a second one.
  if (c.inflight) return c.inflight;
  // `c` is captured deliberately: if the cell is reset mid-flight, this write lands in the
  // DETACHED cell and the fresh one stays honestly cold rather than inheriting a stray reading.
  c.inflight = (async () => {
    try {
      const s = await getNodeStatus("page");
      // A FAILED READ MUST NOT CLEAR A GOOD ONE. getNodeStatus returns null for every failure it
      // knows about, and overwriting a 3-second-old reading with that null would make the card
      // flicker to unknown on a single wobble - which is the failure this cache exists to absorb.
      // The reading simply ages toward MAX_AGE, and says nothing once it gets there.
      if (s !== null) {
        c.status = s;
        c.at = Date.now();
      }
    } catch {
      // getNodeStatus returns rather than throws on every path it knows about; this is the backstop
      // for one it does not. Same outcome: the cache ages rather than lying.
    } finally {
      c.inflight = null;
    }
  })();
  return c.inflight;
}

/**
 * What the cache holds right now, aged honestly, with the money-path verdict RECOMPUTED.
 *
 * CACHE THE FACTS, RECOMPUTE THE VERDICTS (@SDE-Research). `canBuildTx` is not a display field - it
 * is the send gate's answer to "may we build a transaction that can actually confirm", and
 * `faucetPhase.ts:146` ACTS on it. Serving a cached `true` while the real answer is `false` shows a
 * ready page, takes the visitor's proof-of-work, and then refuses them at `/api/faucet`.
 *
 * `readChainFreshness` (shieldGate.ts:264) and `mayBuildTransaction` (:207) are synchronous pure
 * functions of the height, so the verdict can be recomputed on every serve from the cached FACT.
 * An old height carrying a current judgement about it beats a fresh-looking page carrying an old
 * judgement.
 *
 * WHAT IS NOT RECOMPUTED, AND WHY, STATED AS A LIMIT RATHER THAN CLOSED: `frozen`, `ready`,
 * `tipStalledMs` and `networkQuiet` come from `tipProgress`, which MUTATES the module-level
 * `lastTip` it compares against. Calling it per request against a cached height would feed it the
 * same height repeatedly and manufacture a stall. They are therefore served as read, and the only
 * thing bounding them is NODE_STATUS_MAX_AGE_MS - which is why that number is tight.
 */
export function cachedNodeStatus(nowMs: number = Date.now()): NodeStatus | null {
  const c = cell();
  if (c.at === 0 || nowMs - c.at > NODE_STATUS_MAX_AGE_MS) return null;
  const s = c.status;
  if (s === null) return null;
  const shield = readChainFreshness(s.nodeHeight);
  return { ...s, shield, canBuildTx: mayBuildTransaction(shield) };
}

/** How old the served reading is, or null when there is nothing to age. For callers that report it. */
export function cachedNodeStatusAgeMs(nowMs: number = Date.now()): number | null {
  const c = cell();
  if (c.at === 0) return null;
  const age = nowMs - c.at;
  return age > NODE_STATUS_MAX_AGE_MS ? null : age;
}

/**
 * The status for a page render: served from memory, refreshed behind the response.
 *
 * A COLD CACHE WAITS FOR THE FULL READ. Not a capped wait - the whole thing.
 *
 * I SHIPPED THE CAPPED VERSION AND api-integration CAUGHT IT. A capped cold wait converts
 * "cannot verify, so the gate is CLOSED" into "no reading at all": getNodeStatus returns a complete
 * NodeStatus with `canBuildTx: false` when the tip oracle cannot answer, and giving up on that read
 * produces `node: null`, where canBuildTx is not false but UNDEFINED. That is the money gate's
 * fail-closed property turning into an absent field, which is a worse bug than the latency this
 * module removes. Three rows caught it and every one of them is about the same thing.
 *
 * AND THE CAP WAS PROTECTING AGAINST SOMETHING THAT CANNOT HAPPEN HERE. crosslink/cache.ts caps its
 * cold wait because a cold cTAZ read can take 75 seconds. This read is `purpose: "page"` - ONE
 * attempt at a 4s budget - so awaiting it fully is bounded by that budget, and it is EXACTLY what
 * the route did before this module existed. So the cold request is never slower than main, every
 * later request is far faster, and no request loses the verdict.
 *
 * The cache is process-wide, so this is paid by one request per deploy and not one per visitor
 * (@SDE-App).
 */
export async function nodeStatusForPage(nowMs: number = Date.now()): Promise<NodeStatus | null> {
  const c = cell();
  const age = c.at === 0 ? Infinity : nowMs - c.at;
  // ASK THE SERVE PATH WHETHER THERE IS ANYTHING TO SERVE, rather than re-deriving it (@SDE-App).
  // "Nothing to serve" has TWO cases - never read, and read but past the window - and the first
  // version of this gated on `c.at === 0`, which is only the first of them. Calling
  // cachedNodeStatus here means the two definitions cannot drift apart later.
  if (cachedNodeStatus(nowMs) === null) {
    // NOTHING SERVEABLE MEANS WAIT. This is the bug api-integration caught and my first fix only
    // covered half of it: an entry that EXISTS but is past the window still has nothing to return,
    // so not waiting produced `node: null` - and node:null makes canBuildTx UNDEFINED rather than
    // FALSE. The money gate's fail-closed verdict went missing exactly when the oracle could not
    // verify it.
    //
    // AND IT IS A PRODUCTION DEFECT, NOT A SUITE ARTEFACT (@SDE-App measured it): the window is
    // 15s and the page polls every 4s, so the cell stays serveable only while somebody is ALREADY
    // looking. A visitor arriving more than 15s after the last page load hits a warm-but-stale
    // cell - which on a quiet faucet is most first visits, and is exactly the reload the owner
    // reported. Gated on `c.at === 0` this PR would have made that load WORSE than main.
    await refresh();
  } else if (age > REFRESH_AFTER_MS) {
    // SERVEABLE BUT AGEING: refresh behind the response and answer from memory now. This is the
    // whole point of the module and the only branch that must never await.
    void refresh();
  }
  return cachedNodeStatus(nowMs);
}

/** Test seam: globalThis state would otherwise leak between cases. */
export function resetNodeStatusCacheForTests(): void {
  delete g.__nodeStatusCache;
}

/** Test seam: force one refresh and wait for it, so tests need no timers. */
export async function refreshNodeStatusForTests(): Promise<void> {
  await refresh();
}
