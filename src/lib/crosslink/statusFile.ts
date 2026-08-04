/**
 * Read the Crosslink node's state off the bind mount the box writes (#322).
 *
 * WHY A FILE. The faucet container cannot reach the node's RPC by any route: the node
 * binds loopback only, the container's own loopback is not the host's, the bridge gateway
 * times out, and host.docker.internal is not defined in this compose setup. Measured, not
 * assumed. So `readCtazRecency` calling fetch directly can only ever return cannot-verify
 * in production, whatever the toggle says. deploy/z3/ctaz-status.sh polls over loopback on
 * the host and writes here.
 *
 * Same shape as boxIntegrityFile.ts, deliberately, down to the failure modes: an absent
 * file, an unreadable one and a stale one are three different facts and none of them is
 * "the node is fine".
 *
 * PARSE FAILURE IS NOT ZERO AND NOT FALSE. Every numeric field is null when it did not
 * arrive. A sync percent of 0 says "barely started" about a node that may be at tip, and
 * this file's whole reason for existing is that a wrong number is worse than no number.
 */
import { readFileSync } from "node:fs";

export interface CtazStatusFile {
  /** The writer ran and the node answered. False means the writer ran and it did not. */
  readable: boolean;
  /** When the box wrote this, epoch ms. Null when the file itself would not parse. */
  at: number | null;
  blocks: number | null;
  /** The node's own estimate of the network tip, which is the percent's denominator. */
  tip: number | null;
  /** One decimal place, 0 to 100, or null when either side of the ratio was missing. */
  syncPercent: number | null;
  /** The raw `get_tfl_recency_status` result, handed to readingFor() unchanged so the
   *  classification lives in one place. Null when TFL is off or the call failed. */
  recency: unknown;
}

const ABSENT: CtazStatusFile = {
  readable: false,
  at: null,
  blocks: null,
  tip: null,
  syncPercent: null,
  recency: null,
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Read and parse. Returns ABSENT for every failure, and the CALLER decides what an absent
 * file means, because that judgement depends on staleness and belongs with the gate rather
 * than with the reader.
 *
 * No throw on a missing file: cTAZ is off by default, so on most deploys this file
 * legitimately does not exist and that is not an error worth a stack trace.
 */
export function readCtazStatusFile(path: string): CtazStatusFile {
  if (!path) return ABSENT;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return ABSENT;
  }
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      // Only an explicit true counts. A file that omits the field is not making the claim,
      // and defaulting it to true would let a truncated write vouch for the node.
      readable: j.readable === true,
      at: num(j.at),
      blocks: num(j.blocks),
      tip: num(j.tip),
      syncPercent: num(j.syncPercent),
      recency: j.recency ?? null,
    };
  } catch {
    // Truncated JSON, which is what a reader catching a half-written file sees. The writer
    // writes atomically via mv to make this unreachable, and this handles it anyway
    // because "unreachable" is a claim about a script we do not run.
    return ABSENT;
  }
}

/**
 * How old the file may be before it stops describing now.
 *
 * The writer runs on a timer. Three intervals of slack, so one skipped run does not flip
 * the panel to unknown, and a writer that has actually stopped is caught inside a couple
 * of minutes. Same reasoning as the box report's staleness window, and the same reason it
 * is not zero: a threshold with no slack flaps on ordinary jitter.
 */
export const STATUS_STALE_AFTER_MS = 3 * 60_000;

export function statusIsStale(f: CtazStatusFile, nowMs: number): boolean {
  // An unparseable file has no timestamp, and calling that "not stale" would let it
  // masquerade as current. No timestamp means we cannot date it, which is stale enough.
  if (f.at == null) return true;
  // A FUTURE timestamp is not fresh. The box's clock and ours are different machines, and
  // a file stamped ahead of us would otherwise produce a negative age that passes every
  // staleness test. Same rule the miner heartbeat and the recency gate already follow.
  const age = nowMs - f.at;
  return age < 0 || age > STATUS_STALE_AFTER_MS;
}
