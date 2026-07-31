/**
 * Does the BOX have what the repo says it must have?
 *
 * WHY THIS EXISTS. Every gate we had verified the REPO. CI proves main is good,
 * branch protection proves nothing merges red, and the merge checks prove a PR
 * reached main. None of that says a single byte reached production. On 2026-07-31
 * we found nine of fourteen ops scripts had never been installed, including
 * audit-drift.sh, whose entire job is catching exactly that. A detector nobody
 * installs and nobody runs is a comment.
 *
 * So the box publishes what it has, the app reports a verdict, and live-smoke
 * asserts it from outside every 15 minutes. live-smoke is the only signal that has
 * ever reached us unprompted: it caught the disk outage and the HTTPS outage when
 * every internal check read healthy. Hanging this on it means a missing script
 * turns CI red rather than sitting in a log nobody opens.
 *
 * NO NAMES, ONLY COUNTS. /api/status is public. Publishing which files are missing
 * from a production box is reconnaissance, so the endpoint carries numbers and a
 * verdict; an operator runs the audit for detail.
 *
 * Pure, so every state is reachable in a test without a box.
 */

/** Past this, the report describes a box that may no longer exist. */
export const STALE_AFTER_MS = 30 * 60_000;

export type IntegrityState =
  | "complete" // everything the repo ships is installed, current, and enabled
  | "incomplete" // something required is missing, stale, or not enabled
  | "unknown"; // no report, or too old to describe now

export interface IntegrityReport {
  /** Files the repo ships that the box should have. */
  expected: number;
  /** Of those, how many are installed AND byte-identical to the repo copy. */
  present: number;
  /** Units installed but not enabled: they die at the next reboot. */
  notEnabled: number;
  /** When the box wrote this, epoch ms. */
  at: number | null;
  /** The writer could not determine the answer, so it said so. */
  readable: boolean;
}

export interface IntegrityStatus {
  state: IntegrityState;
  expected: number | null;
  present: number | null;
  missing: number | null;
  notEnabled: number | null;
  ageSeconds: number | null;
  reason: string;
}

export function classifyIntegrity(r: IntegrityReport | null, now: number): IntegrityStatus {
  const none = { expected: null, present: null, missing: null, notEnabled: null, ageSeconds: null };

  // No report at all is the state the box was ACTUALLY in all week, so it must not
  // be quiet. It is not "complete" and it is not a proven fault: it is unverified,
  // and unverified is what the gate fails on.
  if (!r || !r.readable || r.at === null) {
    return {
      state: "unknown",
      ...none,
      reason:
        "the box has not reported what it has installed, so whether it matches the " +
        "repo is unverified",
    };
  }

  const ageMs = Math.max(0, now - r.at);
  const age = Math.round(ageMs / 1000);

  if (ageMs > STALE_AFTER_MS) {
    return {
      state: "unknown",
      ...none,
      ageSeconds: age,
      reason: `the last box report is ${Math.round(age / 60)} minutes old, so it no longer describes now`,
    };
  }

  const missing = Math.max(0, r.expected - r.present);

  if (missing > 0 || r.notEnabled > 0) {
    const parts: string[] = [];
    if (missing > 0) parts.push(`${missing} of ${r.expected} required files missing or stale`);
    // Installed-but-disabled is its own failure: it works until the next reboot and
    // then silently does not, which is worse than never having been installed.
    if (r.notEnabled > 0) parts.push(`${r.notEnabled} unit(s) installed but not enabled`);
    return {
      state: "incomplete",
      expected: r.expected,
      present: r.present,
      missing,
      notEnabled: r.notEnabled,
      ageSeconds: age,
      reason: parts.join(", "),
    };
  }

  return {
    state: "complete",
    expected: r.expected,
    present: r.present,
    missing: 0,
    notEnabled: 0,
    ageSeconds: age,
    reason: `all ${r.expected} required files installed, current and enabled`,
  };
}

/**
 * What the external gate fails on. `unknown` counts, deliberately: a box that
 * cannot say what it has is exactly the box we had all week, and treating silence
 * as success is the failure this whole module exists to end.
 */
export function isIntegrityFailing(s: IntegrityStatus): boolean {
  return s.state !== "complete";
}
