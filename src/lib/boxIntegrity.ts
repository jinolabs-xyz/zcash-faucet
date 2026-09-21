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
 * asserts it from outside on a schedule (best-effort: the cron asks for 15 minutes,
 * GitHub delivered about five hours when it was measured, which is why the page rule
 * reads the clock instead of counting runs). live-smoke is the only signal that has
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
/** Past this, the drift audit's last answer no longer describes now. The audit runs every 30
 *  minutes (faucet-drift-report.timer); 90 is three missed runs, and a box a person changed
 *  at 09:00 reads as stale-then-drift in GitHub before lunch instead of clean until 03:40. */
export const DRIFT_STALE_AFTER_MS = 90 * 60_000;

export type IntegrityState =
  | "complete" // everything the repo ships is installed, current, and enabled
  | "incomplete" // something required is missing, stale, or not enabled
  | "unknown"; // no report, or too old to describe now

/** One audit's counts as drift-report.sh publishes them: rc is the audit's own exit (0 clean,
 *  1 findings, 2 incomplete, 3 could not run), the two counts are DRIFT lines and NOT VERIFIED
 *  items. Counts only, never a finding's text: /api/status is public. */
export interface DriftAuditCounts {
  rc: number;
  findings: number;
  unverified: number;
}
/** The drift audit's last result, carried by box-report from drift-report's summary. `at` is
 *  the audit's own clock, not box-report's; `repoSha` is the checkout the audit compared
 *  against, which is how a reader tells "clean against main" from "clean against a checkout
 *  that stopped moving". Null when the box has never published one, or the file was not
 *  the shape drift-report.sh writes. */
export interface DriftReport {
  at: number;
  repoSha: string | null;
  config: DriftAuditCounts;
  access: DriftAuditCounts;
}

export interface IntegrityReport {
  /** Files the repo ships that the box should have. */
  expected: number;
  /** Of those, how many are installed AND byte-identical to the repo copy. */
  present: number;
  /** Units installed but not enabled: they die at the next reboot. */
  notEnabled: number;
  /** Units THIS REPO SHIPS that are enabled without being declared in enabled-units:
   * operator drift, informational, never part of the verdict. Null when the report
   * predates the field, because unmeasured is not zero.
   *
   * SCOPE MATTERS AND IT IS NARROWER THAN THE NAME. box-report walks deploy/z3/*.service
   * and *.timer only, so units we do not ship are invisible here. The box had eleven
   * undeclared units on 2026-08-04 while this said 2, and both were correct: the other
   * nine are dbus aliases and syslog, which will never be repo-declared and would be
   * permanent noise. Anyone widening this should widen the label with it. */
  enabledUndeclared: number | null;
  /** Cumulative restarts of the watchdog unit (#365). Context only. */
  watchdogRestarts: number | null;
  /** Restarts since the box's previous report, which is the figure that carries a rate.
   * Null on the first report and after the counter resets. */
  watchdogRestartsDelta: number | null;
  /** The box's CPU architecture, from `uname -m`. Context only, never classified on.
   *
   * It exists because the architecture was written down nowhere anyone could see and
   * had to be fetched by hand (#332). Adding it to the writer did not close that gap,
   * because this reader dropped it on the floor for two more days (#392): a field that
   * is measured, transmitted and then discarded is indistinguishable from one nobody
   * added. Null on a report that predates the field. */
  platform: string | null;
  /** Whether the compiled miner binary on the box matches the repo: current, stale,
   * absent, untracked, or unknown.
   *
   * box-report emits it as its own field AS WELL AS counting it, in its own words "so
   * the panel can say WHY the count is short instead of only that it is". The panel
   * could not, because this reader never parsed it. Null on an older report. */
  minerBinary: string | null;
  /** systemd's word for the miner UNIT: active, inactive, failed, activating,
   * deactivating, or unknown when systemctl would not say. Null on a report that
   * predates the field.
   *
   * The heartbeat cannot tell a miner an operator stopped on purpose from one that
   * died: both are a file nobody writes. On 2026-09-08 the panel shouted NO HEARTBEAT in
   * red for hours over a unit that was parked deliberately. This is the fact that lets
   * it say "off" instead, and it is context only, never classified on. */
  minerUnit: string | null;
  /** The watchdog unit's systemd word, the same way. A STOPPED watchdog used to be
   *  invisible: is-enabled is true of a stopped unit, Restart=always means it never
   *  reaches failed, and the restart counter counts restarts, of which a unit somebody
   *  stopped has none (risk register #16). Unlike the miner's word this one IS a fault
   *  when it reads inactive or failed: nothing heals while the watchdog is down. Null
   *  on a report that predates the field. */
  watchdogUnit: string | null;
  /** Whether the box can page anyone, in the box's own word: "ok" (the bridge answers
   *  and the configured number is linked), "unlinked", "down", "misconfigured" (a state
   *  the sender refuses to send in: Signal without a usable number or recipient, or, for
   *  any format, a box with neither jq nor python3), "webhook" (Slack or
   *  Discord, nothing to probe), "none" (no alert URL at all), "unknown" (could not
   *  ask), or null from a report that predates the field. The bridge cannot report its
   *  own death through itself, so this is where a dead one shows, and the off-box probe
   *  reads it. A STATE WORD, and the one exception to "no names, only counts" below: it
   *  tells a reader whether pages are arriving. Since R-24 it reaches the off-box probe
   *  only with the operator token; the public gets it folded into one word. */
  alertBridge: string | null;
  /** When the box wrote this, epoch ms. */
  at: number | null;
  /** The writer could not determine the answer, so it said so. */
  readable: boolean;
  /** Absent (undefined) on a report older than the field; null when the box published
   *  none. Both classify as unknown, and unknown fails the off-box gate. */
  drift?: DriftReport | null;
}

/** DOES THE BOX MATCH THE REPO, as the box's own audit last answered it. Its own verdict
 *  beside `state`, not folded into it: box-report already counts installed-and-current
 *  files, the audit counts them again among other things, and one fault would then be
 *  counted twice (the rule at IntegrityStatus below). Every word here is one the off-box
 *  probe fails on except "clean", and "stale" is a word of its own because an audit that
 *  stopped arriving is L54: silence that must never read as yesterday's clean. */
export type DriftState = "clean" | "drift" | "incomplete" | "stale" | "unknown";
export interface DriftStatus {
  state: DriftState;
  findings: number | null;
  unverified: number | null;
  ageSeconds: number | null;
  repoSha: string | null;
  reason: string;
}

export function classifyDrift(d: DriftReport | null | undefined, now: number): DriftStatus {
  const none = { findings: null, unverified: null, ageSeconds: null, repoSha: null };
  if (d === undefined) return { state: "unknown", ...none, reason: "the box's report predates the drift field, so the audit's verdict is not carried" };
  if (d === null) return { state: "unknown", ...none, reason: "the box has not published a drift audit result" };
  const ageMs = Math.max(0, now - d.at);
  const age = Math.round(ageMs / 1000);
  const findings = d.config.findings + d.access.findings;
  const unverified = d.config.unverified + d.access.unverified;
  const carried = { findings, unverified, ageSeconds: age, repoSha: d.repoSha };
  if (ageMs > DRIFT_STALE_AFTER_MS) {
    return { state: "stale", ...carried, reason: `the last drift audit is ${Math.round(age / 60)} minutes old; it runs every 30, so it has stopped arriving` };
  }
  // THE EXIT CODE OUTRANKS THE COUNT, in both directions. The counts are a grep over the
  // audit's text and a grep can miss a word - it did: audit-access.sh says FINDING where
  // audit-drift.sh says DRIFT, and the first cut of the wrapper counted one word, so an
  // access finding arrived as rc 1 with findings 0 and a count-first reader called it clean
  // (App's block on #726). The rc is the audit's own verdict and needs no parsing, so:
  //   rc 3   could not run       -> incomplete, whatever the zeros say
  //   rc 1   findings            -> drift, even at a count of 0 (the count is then unmeasured)
  //   rc 2   incomplete          -> incomplete
  //   rc 0 with findings above 0 -> drift: a contradiction never reads clean
  if (d.config.rc >= 3 || d.access.rc >= 3) {
    return { state: "incomplete", ...carried, reason: "a drift audit could not run on the box, so its findings are unmeasured" };
  }
  if (d.config.rc === 1 || d.access.rc === 1 || findings > 0) {
    const count = findings > 0 ? `${findings} finding(s)` : "findings the audit reported but the wrapper did not count";
    return { state: "drift", ...carried, reason: `${count}: the box and the repo disagree; the box's own journal names them` };
  }
  if (unverified > 0 || d.config.rc === 2 || d.access.rc === 2) {
    return { state: "incomplete", ...carried, reason: `no drift in what could be checked, but ${unverified} check(s) could not run` };
  }
  return { state: "clean", ...carried, reason: "the box matches the repo in every check the audit made" };
}

export interface IntegrityStatus {
  state: IntegrityState;
  expected: number | null;
  present: number | null;
  missing: number | null;
  notEnabled: number | null;
  /** Passed through, never classified on: drift is a fact to surface, not a fault. */
  enabledUndeclared: number | null;
  /** Cumulative restarts of the watchdog unit. Context only, never classified on: it
   *  never resets, so it cannot distinguish an old fault from a live one. */
  watchdogRestarts: number | null;
  /** Restarts since the box's PREVIOUS report, which is the figure that means
   *  something. Null when there is no previous report or the counter reset. */
  watchdogRestartsDelta: number | null;
  /** Passed through from the report. Context, never classified on. */
  platform: string | null;
  /** Passed through from the report, and the reason `missing` can be explained rather
   *  than only counted. Never classified on: the file count already carries the
   *  verdict, and counting the same fact twice would double a single fault. */
  minerBinary: string | null;
  /** Passed through from the report; the panel uses it to tell a parked miner from a
   *  dead one. Context, never classified on. */
  minerUnit: string | null;
  /** The watchdog unit's systemd word, the same way. A STOPPED watchdog used to be
   *  invisible: is-enabled is true of a stopped unit, Restart=always means it never
   *  reaches failed, and the restart counter counts restarts, of which a unit somebody
   *  stopped has none (risk register #16). Unlike the miner's word this one IS a fault
   *  when it reads inactive or failed: nothing heals while the watchdog is down. Null
   *  on a report that predates the field. */
  watchdogUnit: string | null;
  /** Whether the box can page anyone, in the box's own word: "ok" (the bridge answers
   *  and the configured number is linked), "unlinked", "down", "misconfigured" (a state
   *  the sender refuses to send in: Signal without a usable number or recipient, or, for
   *  any format, a box with neither jq nor python3), "webhook" (Slack or
   *  Discord, nothing to probe), "none" (no alert URL at all), "unknown" (could not
   *  ask), or null from a report that predates the field. The bridge cannot report its
   *  own death through itself, so this is where a dead one shows, and the off-box probe
   *  reads it. A STATE WORD, and the one exception to "no names, only counts" below: it
   *  tells a reader whether pages are arriving. Since R-24 it reaches the off-box probe
   *  only with the operator token; the public gets it folded into one word. */
  alertBridge: string | null;
  ageSeconds: number | null;
  /** The drift audit's own verdict (see DriftStatus). Classified even when the report is
   *  stale or unknown, from whatever the report carried: the two clocks are independent. */
  drift: DriftStatus;
  reason: string;
}
export function classifyIntegrity(r: IntegrityReport | null, now: number): IntegrityStatus {
  const drift = classifyDrift(r?.drift, now);
  const none = { expected: null, present: null, missing: null, notEnabled: null, enabledUndeclared: null, watchdogRestarts: null, watchdogRestartsDelta: null, platform: null, minerBinary: null, minerUnit: null, watchdogUnit: null, alertBridge: null, ageSeconds: null };

  // No report at all is the state the box was ACTUALLY in all week, so it must not
  // be quiet. It is not "complete" and it is not a proven fault: it is unverified,
  // and unverified is what the gate fails on.
  if (!r || !r.readable || r.at === null) {
    return {
      state: "unknown",
      ...none,
      drift,
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
      drift,
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
      enabledUndeclared: r.enabledUndeclared,
      watchdogRestarts: r.watchdogRestarts,
      watchdogRestartsDelta: r.watchdogRestartsDelta,
      platform: r.platform,
      minerBinary: r.minerBinary,
      minerUnit: r.minerUnit,
      watchdogUnit: r.watchdogUnit,
      alertBridge: r.alertBridge,
      ageSeconds: age,
      drift,
      reason: parts.join(", "),
    };
  }

  return {
    state: "complete",
    expected: r.expected,
    present: r.present,
    missing: 0,
    notEnabled: 0,
    enabledUndeclared: r.enabledUndeclared,
    watchdogRestarts: r.watchdogRestarts,
    watchdogRestartsDelta: r.watchdogRestartsDelta,
    platform: r.platform,
    minerBinary: r.minerBinary,
    minerUnit: r.minerUnit,
    watchdogUnit: r.watchdogUnit,
    alertBridge: r.alertBridge,
    ageSeconds: age,
    drift,
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
