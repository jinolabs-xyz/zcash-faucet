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
 * Matched to the page's own 4s poll, so the cache is never more than one poll behind what a fresh
 * read would have said. The load reduction is per-PROCESS rather than per-interval: the read used
 * to happen once per visitor per poll, and now happens once per window however many are looking.
 */
const REFRESH_AFTER_MS = 4_000;

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
 * ONLY A COLD CACHE WAITS, and it waits on a cap rather than on the wallet. Against the local
 * doubles the first read finishes in milliseconds so the wait is invisible; against a slow wallet
 * the cap fires long before the read does and the caller gets the same "cannot say" the page
 * rendered before. crosslink/cache.ts records a CI flake from getting exactly this wrong - the
 * suite boots the server and drives the page immediately, and a first request that races the
 * warm-up renders not-ready against a perfectly healthy double.
 *
 * 3s, NOT THE 1.5s I FIRST WROTE, and the reason is a measurement rather than a feel. The cache is
 * SERVER-SIDE and process-wide, so it is cold ONCE PER DEPLOY and not once per visitor (@SDE-App) -
 * the wait is paid by one request in a process's whole life. And SDE-Research's distribution puts
 * the mode of a successful read at 2-3s, so a 1.5s cap would have missed the TYPICAL first read and
 * handed that one visitor a gap for no reason. Sized to catch the mode, not the tail.
 */
export async function nodeStatusForPage(
  nowMs: number = Date.now(),
  coldWaitMs = 3_000,
): Promise<NodeStatus | null> {
  const c = cell();
  const age = c.at === 0 ? Infinity : nowMs - c.at;
  if (age > REFRESH_AFTER_MS) {
    const p = refresh();
    // THE RESPONSE DOES NOT AWAIT A WARM REFRESH. That await is the entire defect this module
    // exists to remove: awaiting here would put the wallet's latency back on the request path
    // with extra steps.
    if (c.at === 0) await Promise.race([p, new Promise((r) => setTimeout(r, coldWaitMs))]);
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
