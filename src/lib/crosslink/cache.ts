/**
 * The cTAZ node's state, read in the background and served from memory.
 *
 * WHY A CACHE, WHEN read.ts ONCE SAID "NO CACHE" ABOUT THE MINER HEARTBEAT. That rule is
 * right for a hundred-byte file on local disk. This read crosses a socket to a broker to
 * a node whose RPC thread is starved by its own miner. Measured on the box, eight
 * consecutive calls: 20ms, 30013ms, 6957ms, 607ms, 21ms, 48ms, 13748ms, 24077ms. No
 * fixed request-path timeout survives that distribution: 4 seconds hangs nothing but
 * abandons half the calls (and the broker then dies on a broken pipe writing to the
 * vanished client), 30 seconds hangs every status poll and still is not always enough.
 *
 * So the expensive read happens OFF the request path, on an interval, with a timeout the
 * node's worst case can actually meet, and /api/status reads memory. Same shape as the
 * independent tip cache instrumentation.ts already warms.
 *
 * ON globalThis, NOT MODULE STATE. Next hands instrumentation and route handlers
 * different module instances (#241, and db/index.ts documents the same trap), so a
 * module-level variable warmed at boot would be invisible to the routes that need it.
 *
 * A CACHE NOBODY REFRESHES MUST AGE OUT. If the refresher stops (crash, wedged broker
 * past even the long timeout), the cached answer degrades to cannot-verify after
 * MAX_CACHE_AGE_MS rather than describing a node that may have died. Same rule as the
 * status file's own staleness window, for the same reason.
 */
import { readCtazNodeState, type CtazNodeState } from "./read.ts";
import { readingFor } from "./recency.ts";

/** How often the background read runs. A refresh in flight makes the interval skip, so
 *  this is the floor between attempts, not a rate. */
const REFRESH_INTERVAL_MS = 20_000;
/** Past this, the cache is not an answer.
 *
 *  180s, RESIZED AFTER PROD AGED OUT AT 90. The recency call alone measures 8-30s on
 *  this node (its RPC thread starved by its own miner), the refresher runs recency then
 *  getblockchaininfo sequentially, and one slow-plus-one-failed cycle overshot 90s - so
 *  the cache expired between successful refreshes and the gate flapped. 180s tolerates
 *  one full worst-case cycle plus one failure.
 *
 *  THE COST, stated rather than hidden: the gate can serve a reading up to three
 *  minutes old. The drip itself still goes through the node live at send time, so a
 *  node that died inside the window fails the send rather than paying blind - the
 *  staleness bounds the ERROR MESSAGE's accuracy, not the money. */
export const MAX_CACHE_AGE_MS = 180_000;

interface Cached {
  state: CtazNodeState;
  at: number;
  refreshing: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

const g = globalThis as unknown as { __ctazStateCache?: Cached };

function cell(): Cached {
  if (!g.__ctazStateCache) {
    g.__ctazStateCache = { state: emptyState(), at: 0, refreshing: false, timer: null };
  }
  return g.__ctazStateCache;
}

function emptyState(): CtazNodeState {
  return {
    reading: readingFor(null, Date.now()),
    syncPercent: null,
    blocks: null,
    tip: null,
    source: "none",
  };
}

async function refresh(): Promise<void> {
  const c = cell();
  // One in flight at a time. A slow node must not stack refreshes behind itself; the
  // interval just skips a beat and the cache ages, which the age-out already handles.
  if (c.refreshing) return;
  c.refreshing = true;
  try {
    const s = await readCtazNodeState(Date.now());
    c.state = s;
    c.at = Date.now();
  } catch {
    // readCtazNodeState returns rather than throws on every path it knows about, so this
    // is the backstop for the path it does not. The cache simply ages toward the cutoff,
    // which is the honest outcome for a reader that is failing in a new way.
  } finally {
    c.refreshing = false;
  }
}

/** Start the background refresher. Idempotent; instrumentation calls it at boot and the
 *  first read calls it again in case instrumentation never ran (tests, dev). */
export function startCtazStateRefresher(): void {
  const c = cell();
  if (c.timer) return;
  void refresh();
  c.timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  // A background poll must never be the thing keeping the process alive.
  if (typeof c.timer.unref === "function") c.timer.unref();
}

/**
 * The cached state, aged honestly.
 *
 * Never blocks on the node. The first call after boot returns cannot-verify while the
 * warm-up read runs, which is the same answer the page gave before the node had ever
 * been asked, and strictly better than a request that may hang thirty seconds.
 */
export function cachedCtazNodeState(nowMs: number = Date.now()): CtazNodeState {
  const c = cell();
  startCtazStateRefresher();
  if (c.at === 0 || nowMs - c.at > MAX_CACHE_AGE_MS) {
    return emptyState();
  }
  return c.state;
}

/** Test seam: globalThis state would otherwise leak between cases. */
export function resetCtazStateCacheForTests(): void {
  const c = g.__ctazStateCache;
  if (c?.timer) clearInterval(c.timer);
  delete g.__ctazStateCache;
}

/** Test seam: force one refresh and wait for it, so tests need no real timers. */
export async function refreshCtazStateForTests(): Promise<void> {
  await refresh();
}
