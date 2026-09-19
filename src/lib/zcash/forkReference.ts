/**
 * The fork reference published on /api/ready: an independent chain's hash at a height below the
 * tip, for the watchdog to compare against our own node's (#533, R-20).
 *
 * CACHED AND NON-BLOCKING, for the same reason externalTip is: /api/ready is on the money path and
 * a public third party must never be able to slow it down. The read happens in the background and
 * the endpoint serves whatever the last one produced, with its age, so a stale reference is
 * visibly stale rather than silently old.
 *
 * NULL IS A FIRST-CLASS ANSWER HERE. A reference we could not fetch is NOT a fork, and nothing
 * downstream may treat it as one - the watchdog pages on a MISMATCH of two known hashes, never on
 * an absence. That is the whole point of splitting this: "fail on proof, not on cannot-verify".
 */
import { dialBlockHash, REFERENCE_DEPTH } from "./externalBlock.ts";
import { resolveEndpoint } from "./lightwalletd.ts";
import { referenceTip } from "./externalTip.ts";

export interface ForkReference {
  /** The height asked for: the independent tip minus REFERENCE_DEPTH. Null when no tip is known. */
  height: number | null;
  /** Their hash at that height, DISPLAY order, comparable with zebra's getblockhash. */
  hash: string | null;
  /** How old this reading is. Null when nothing has ever been read. */
  ageSeconds: number | null;
  /** The depth below the tip, published so the watchdog does not have to assume it. */
  depth: number;
}

const REFRESH_MS = 60_000;
const DIAL_TIMEOUT_MS = 8_000;

let last: { height: number; hash: string; at: number } | null = null;
let inFlight = false;

/** One background refresh. Never awaited by a request. */
function kick(nowMs: number): void {
  if (inFlight) return;
  if (last && nowMs - last.at < REFRESH_MS) return;
  const tip = referenceTip().height;
  if (tip == null) return;
  const height = tip - REFERENCE_DEPTH;
  if (height <= 0) return;
  inFlight = true;
  void (async () => {
    try {
      const endpoint = await resolveEndpoint();
      if (!endpoint) return;
      const hash = await dialBlockHash(endpoint, height, DIAL_TIMEOUT_MS);
      // ONLY ON SUCCESS. A failed dial leaves the previous reading in place with its age growing,
      // which is more useful than dropping to null - the watchdog can see it going stale and say
      // so, where a null says nothing about whether it ever worked.
      if (hash) last = { height, hash, at: Date.now() };
    } catch {
      // Swallowed on purpose: this is a background read on the money path's endpoint and it may
      // not throw into a request. Its failure is visible as the age below, not as an exception.
    } finally {
      inFlight = false;
    }
  })();
}

export function readForkReference(nowMs: number = Date.now()): ForkReference {
  kick(nowMs);
  return {
    height: last?.height ?? null,
    hash: last?.hash ?? null,
    ageSeconds: last ? Math.round((nowMs - last.at) / 1000) : null,
    depth: REFERENCE_DEPTH,
  };
}

/** Test seam: forget the cached reading. */
export function resetForkReference(): void {
  last = null;
  inFlight = false;
}
