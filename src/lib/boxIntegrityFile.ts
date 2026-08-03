/**
 * Reads the box's self-report from the faucet's data volume.
 *
 * Same transport as the miner heartbeat: the reporter is a systemd unit on the host,
 * the faucet is a container, and /app/data is already a shared writable volume, so
 * no compose change is needed.
 *
 * Every failure returns null. The classifier turns that into `unknown`, which FAILS
 * the gate. That is deliberate and is the entire point: a box that cannot say what it
 * has is exactly the box we had all week.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IntegrityReport } from "./boxIntegrity.ts";

const PATH =
  process.env.FAUCET_BOX_REPORT_PATH ?? join(process.cwd(), "data", "box-integrity.json");

export function readBoxIntegrity(): IntegrityReport | null {
  try {
    const j = JSON.parse(readFileSync(PATH, "utf8")) as Record<string, unknown>;
    if (j.readable === false)
      return { expected: 0, present: 0, notEnabled: 0, enabledUndeclared: null, at: null, readable: false };
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const expected = n(j.expected), present = n(j.present), notEnabled = n(j.notEnabled), at = n(j.at);
    // Any missing field means we cannot form a verdict. Say so rather than
    // defaulting a number to zero, which would read as "nothing missing".
    if (expected === null || present === null || notEnabled === null || at === null) return null;
    // OPTIONAL, not verdict-forming: operator drift, units enabled without being
    // declared in enabled-units. #338 taught the box to write it; this file was
    // silently dropping it, so the declaration file's oldest promise was recorded
    // on the box and invisible everywhere else (#339). Absent (a pre-#338 report)
    // stays null rather than zero: an unmeasured drift is not a measured zero.
    const enabledUndeclared = n(j.enabledUndeclared);
    return { expected, present, notEnabled, enabledUndeclared, at, readable: true };
  } catch {
    return null;
  }
}
