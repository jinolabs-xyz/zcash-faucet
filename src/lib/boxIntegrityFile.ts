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
      return { expected: 0, present: 0, notEnabled: 0, enabledUndeclared: null, watchdogRestarts: null, watchdogRestartsDelta: null, platform: null, minerBinary: null, at: null, readable: false };
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    // Strings, and empty is not a value. box-report defaults platform to the literal
    // "unknown" when uname says nothing, so an empty string here means the field was
    // damaged in transit rather than honestly unset - null says that, "" would render
    // as a blank cell that looks like a measurement.
    const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
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
    // Both nullable, and null is the honest answer when systemctl would not say. 0 would
    // report a calm watchdog, which is a claim the box did not make.
    const watchdogRestarts = n(j.watchdogRestarts);
    const watchdogRestartsDelta = n(j.watchdogRestartsDelta);
    // WRITTEN BY THE BOX SINCE #332 AND #338 AND PARSED HERE BY NOBODY UNTIL #392.
    // Two fields measured on the box, serialised, shipped through a volume, and
    // dropped one line before they became visible. `platform` was added because the
    // architecture "had to be fetched by hand", and it still had to. `minerBinary`
    // exists so the panel can say WHY a file count is short, and the panel could not.
    //
    // The round-trip test added with this compares the SET of keys the writer emits
    // against the set this function returns, because a test that checks only the
    // fields we already read is the test that missed these two.
    const platform = s(j.platform);
    const minerBinary = s(j.minerBinary);
    return { expected, present, notEnabled, enabledUndeclared, watchdogRestarts, watchdogRestartsDelta, platform, minerBinary, at, readable: true };
  } catch {
    return null;
  }
}
