/**
 * Fixed-window per-key rate limiter, in memory.
 *
 * For READ endpoints (#90). The claim path does not use this: it limits on
 * address through the ledger, which survives restarts and is the right shape
 * when money moves. This one guards cheap-to-call reads that each cost us a
 * wallet RPC, where a durable store would be more machinery than the problem
 * deserves.
 *
 * Fixed window rather than sliding: a sliding window needs per-key timestamp
 * lists, and the extra precision buys nothing here. The known cost is a burst at
 * a window boundary can serve up to 2x max, which for a read is fine.
 *
 * Keys are expected to be salted IP fingerprints, never raw IPs. See privacy.ts.
 */

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window rolls over. 0 when allowed. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitVerdict;
  /** Keys currently tracked. Exposed so the memory bound is testable. */
  readonly size: number;
}

/**
 * Hard ceiling on tracked keys, so the limiter cannot become the memory leak it
 * was added to prevent. Past this we allow rather than deny: see check().
 */
export const MAX_TRACKED_KEYS = 20_000;

interface Window {
  startedAt: number;
  count: number;
}

/** `now` returns SECONDS and is injectable so tests need no sleeping. */
export function createRateLimiter(opts: {
  windowSeconds: number;
  max: number;
  now?: () => number;
}): RateLimiter {
  const windowSeconds = Math.max(1, Math.floor(opts.windowSeconds));
  const max = Math.max(1, Math.floor(opts.max));
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const windows = new Map<string, Window>();
  let nextSweep = now() + windowSeconds;

  /** Drop windows that have rolled over. O(n), but at most once per window. */
  function sweep(at: number): void {
    for (const [key, w] of windows) {
      if (at - w.startedAt >= windowSeconds) windows.delete(key);
    }
    nextSweep = at + windowSeconds;
  }

  return {
    get size() {
      return windows.size;
    },

    check(key: string): RateLimitVerdict {
      const at = now();
      if (at >= nextSweep || windows.size > MAX_TRACKED_KEYS) sweep(at);

      const existing = windows.get(key);
      if (!existing || at - existing.startedAt >= windowSeconds) {
        // A brand new key while the table is full: allow it and do not track.
        //
        // Failing OPEN is deliberate. Filling the table takes traffic from tens
        // of thousands of distinct addresses, and anyone with that many is not
        // being stopped by a per-IP limit anyway. Denying instead would turn
        // their flood into an outage for everybody else, which hands them a
        // better outcome than the one they were going for.
        if (!existing && windows.size >= MAX_TRACKED_KEYS) {
          return { allowed: true, retryAfterSeconds: 0 };
        }
        windows.set(key, { startedAt: at, count: 1 });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (existing.count < max) {
        existing.count++;
        return { allowed: true, retryAfterSeconds: 0 };
      }
      return {
        allowed: false,
        // At least 1: a caller told to retry in 0 seconds retries immediately.
        retryAfterSeconds: Math.max(1, windowSeconds - (at - existing.startedAt)),
      };
    },
  };
}
