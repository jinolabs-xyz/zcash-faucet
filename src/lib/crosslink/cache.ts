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

/** How often the background read runs. The node answers in ms when its RPC thread gets
 *  CPU, so this is about bounding staleness, not load. */
const REFRESH_INTERVAL_MS = 15_000;
/** Past this, the cache is not an answer. 90s tolerates two slow refreshes back to back;
 *  the recency reading's own 120s staleness rule still applies on top, at read time. */
const MAX_CACHE_AGE_MS = 90_000;

interface Cached {
  state: CtazNodeState;
  at: number;
  refreshing: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** The in-flight refresh, ON THE CELL and not at module level. The first version kept
   *  it in a module variable, and the test seam that resets the cell orphaned a running
   *  promise - the next test then ADOPTED the previous test's refresh, wrote its result
   *  into the fresh cell, and three tests failed with answers from each other's brokers.
   *  Production has the same shape in miniature: anything that resets the cell must also
   *  detach the refresh, or the new cell inherits a stale write. */
  inflight: Promise<void> | null;
}

const g = globalThis as unknown as { __ctazStateCache?: Cached };

function cell(): Cached {
  if (!g.__ctazStateCache) {
    g.__ctazStateCache = { state: emptyState(), at: 0, refreshing: false, timer: null, inflight: null };
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

function refresh(): Promise<void> {
  const c = cell();
  // One in flight at a time. A slow node must not stack refreshes behind itself; the
  // interval just skips a beat and the cache ages, which the age-out already handles.
  // The in-flight promise is kept so a cold first request can WAIT on it briefly
  // instead of racing it - see cachedCtazNodeStateWarm.
  if (c.inflight) return c.inflight;
  c.refreshing = true;
  // `c` is captured, deliberately: if the cell is reset mid-flight, this promise
  // finishes writing into the DETACHED cell and the fresh one stays honestly cold.
  c.inflight = (async () => {
    try {
      const s = await readCtazNodeState(Date.now());
      c.state = s;
      c.at = Date.now();
    } catch {
      // readCtazNodeState returns rather than throws on every path it knows about, so
      // this is the backstop for the path it does not. The cache simply ages toward the
      // cutoff, which is the honest outcome for a reader failing in a new way.
    } finally {
      c.refreshing = false;
      c.inflight = null;
    }
  })();
  return c.inflight;
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

/**
 * Like cachedCtazNodeState, but a COLD cache waits briefly for the warm-up read.
 *
 * The race this closes shipped as a CI flake within hours of the cache: ui-smoke
 * boots the server and drives the page immediately, and the first status request
 * could land before the boot refresh finished - so the page rendered cTAZ
 * not-ready against a perfectly healthy double, once in a while, on unrelated
 * PRs. A monitor that flakes teaches people to rerun it, which is this week's
 * whole lesson about red signals nobody reads.
 *
 * BOUNDED, never the node's worst case. Against the CI double the warm-up
 * finishes in milliseconds, so the wait is invisible; against the real node the
 * cap fires long before the 75s read completes and the caller gets the same
 * cold cannot-verify as before - first requests after a prod deploy stay fast
 * and honest. Only a COLD cache waits: once warm, this is the plain cache read.
 */
export async function cachedCtazNodeStateWarm(
  nowMs: number = Date.now(),
  coldWaitMs = 1_500,
): Promise<CtazNodeState> {
  const c = cell();
  startCtazStateRefresher();
  if (c.at === 0 && c.inflight) {
    await Promise.race([c.inflight, new Promise((r) => setTimeout(r, coldWaitMs))]);
  }
  return cachedCtazNodeState(nowMs);
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
