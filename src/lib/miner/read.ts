/**
 * Reading the miner heartbeat off disk. The classification lives in heartbeat.ts and
 * is pure; this is the only part that touches the filesystem.
 *
 * NO CACHE. The file is a few hundred bytes on a read-only bind mount and /api/status
 * is the only caller, so a cache would buy microseconds and cost correctness: a cached
 * heartbeat is a stale heartbeat, and staleness is the exact thing this readout exists
 * to detect. It would also need the globalThis dance the ledger probe needed, because
 * Next hands instrumentation and route handlers different module instances (#241).
 */
import { readFileSync } from "node:fs";
import { readingFor, type MinerReading } from "./heartbeat.ts";

/**
 * Every failure lands on the same reading: no path configured, no file, no permission,
 * not JSON. They are all "we could not establish what the miner is doing", and the
 * classifier turns that into cannot-verify rather than into off.
 */
export function readMinerHeartbeat(path: string, nowMs: number = Date.now()): MinerReading {
  if (!path) return readingFor(null, nowMs);
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Deliberately swallowed, and deliberately not logged per call: /api/status is
    // polled, so a missing file would otherwise write a line every few seconds. The
    // state itself is the report, and it surfaces in the panel where someone will see
    // it rather than in a log nobody is tailing.
    return readingFor(null, nowMs);
  }
  return readingFor(raw, nowMs);
}
