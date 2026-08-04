/**
 * What the panel says about the box's own integrity.
 *
 * #287 built the verdict and put it on /api/status. Nothing rendered it. The endpoint
 * knew two files were missing and a unit was installed-but-disabled, and the panel
 * said nothing at all, so the one place a person looks did not carry the one thing
 * that had just been measured for them.
 *
 * Same rule as minerLabel.ts and reserveLabel.ts: `unknown` is not `complete` and not
 * a proven fault. It is unverified, and unverified must not read as either.
 */
import type { IntegrityStatus } from "./boxIntegrity.ts";

/**
 * How many restarts the watchdog took since the box's previous report (#365).
 *
 * THE DELTA, NEVER THE CUMULATIVE COUNT. NRestarts never resets, so a box up for a
 * month with three restarts and a box looping right now print similar-looking numbers
 * and a reader cannot tell which. The delta is per report interval, so it is a rate.
 *
 * AND THIS ONE IS A FAULT, unlike undeclared units. A watchdog restarting in a loop
 * cannot reach systemd's failed state, so its own OnFailure= alert can never fire: the
 * service whose job is noticing that other things are broken is silently broken itself.
 * That is worth red.
 *
 * The threshold is 1 rather than 0. One restart between two reports is a restart, which
 * is ordinary after a deploy or a daemon-reload. Two or more inside one report interval
 * is a loop: at RestartSec=5 a real loop produces about 60 per five minutes.
 */
const WATCHDOG_LOOP_RESTARTS = 2;

export function watchdogLooping(s: IntegrityStatus): boolean {
  return (s.watchdogRestartsDelta ?? 0) >= WATCHDOG_LOOP_RESTARTS;
}

/** The clause, when there is one. Null and 0 render nothing: an unread counter must not
 *  arrive as a calm one, and a calm one does not need a word. */
function watchdog(s: IntegrityStatus): string {
  const d = s.watchdogRestartsDelta;
  if (d == null || d < 1) return "";
  return d >= WATCHDOG_LOOP_RESTARTS
    ? `, WATCHDOG RESTARTING (${d} since last report)`
    : `, watchdog restarted once`;
}

/**
 * Units that are enabled on the box but not declared in the repo, when there are any.
 *
 * A SEPARATE CLAUSE, NEVER PART OF THE COUNT. The counts answer "does the box have
 * what the repo says it must", and an extra enabled unit is a different question:
 * something is running that nothing in the repo asked for. Adding it to `present`
 * would make a drifted box look more complete than a clean one.
 *
 * Deliberately not a fault, so boxIsBad and boxChip are untouched. The two on
 * production today are faucet.service and the autodeploy timer, both of which are
 * meant to be there and simply are not declared in the manifest. Marking that red
 * would train an operator to ignore the marker, which costs more than the row is
 * worth. It still has to be VISIBLE, because the day the extra unit is not one of
 * those two, nobody is going to find it by reading a number that never changed.
 *
 * Null and 0 both render nothing, and they mean different things: 0 is a box that
 * reported no drift, null is a report too old to carry the field. Neither is worth a
 * clause, because a row saying "0 undeclared" is noise and one saying "undeclared
 * unknown" would imply a problem where there is only an old deploy.
 */
function undeclared(s: IntegrityStatus): string {
  const n = s.enabledUndeclared ?? 0;
  // "OF OURS" IS LOAD-BEARING AND I SHIPPED IT WITHOUT IT. box-report only walks the units
  // THIS REPO SHIPS, so the figure is "how many of our own units are enabled without being
  // declared". The bare phrasing read as "how many undeclared units are on this box", and
  // on 2026-08-04 the panel said 2 while the box had ELEVEN: ours plus four dbus aliases
  // and syslog, which we do not ship and would be permanent noise to count.
  //
  // The count was never wrong. The label answered a narrower question than it appeared to,
  // which is the whole of rule 35's second clause, in a row I rendered myself.
  return n > 0 ? `, ${n} of ours enabled but undeclared` : "";
}

/**
 * Why the file count is short, when the miner binary is the reason.
 *
 * box-report has emitted `minerBinary` as its own field since #332, with a comment
 * saying it exists "so the panel can say WHY the count is short instead of only that
 * it is". The panel could not, because the reader dropped the field (#392). This is
 * the clause that comment was written for.
 *
 * ONLY THE STATES THAT EXPLAIN SOMETHING. `current` is the normal case and needs no
 * words on a row that is already long; `untracked` means the repo does not pin a
 * binary, which is not a fault of this box. `stale` and `absent` are the two that turn
 * "one file missing" into an actionable sentence, and `unknown` is worth saying out
 * loud because an unmeasured binary is not a working one.
 */
function miner(s: IntegrityStatus): string {
  switch (s.minerBinary) {
    case "stale":
      return ", miner binary STALE";
    case "absent":
      return ", miner binary ABSENT";
    case "unknown":
      return ", miner binary unverified";
    default:
      return "";
  }
}

/**
 * The panel line. Counts only, never file names: this endpoint is public, and naming
 * what is missing from a production box is reconnaissance. That constraint is #287's
 * and it holds all the way to the screen, not just to the API.
 */
export function boxRow(s: IntegrityStatus): string {
  switch (s.state) {
    case "complete":
      // Undeclared units are appended rather than folded into the count, and they do
      // NOT make the row bad. classifyIntegrity's own comment says drift is a fact to
      // surface rather than a fault.
      //
      // THE HISTORY, CORRECTED, because I got it wrong in the commit that added this
      // clause and a wrong one here is worse than none. The figure reaches the panel
      // through three separate additions: #338 taught box-report.sh to write it, #341
      // passed it through boxIntegrity and boxIntegrityFile to the API, and this is the
      // third. I checked production with curl, saw the field present, and concluded the
      // API had never dropped it. It had: before #341 neither src file mentioned the
      // name at all. I was reading the world after the fix and calling it never-broken,
      // which is rule 35 running backwards, so the same counter applies. `git show
      // <commit>^:<file>` is what settles a question about the past, not a live probe.
      return `${s.expected} of ${s.expected} files, all enabled${miner(s)}${undeclared(s)}${watchdog(s)}`;

    case "incomplete": {
      const parts: string[] = [];
      if ((s.missing ?? 0) > 0) parts.push(`${s.missing} of ${s.expected} MISSING`);
      // Installed but not enabled works until the next reboot and then silently does
      // not, which is worse than never having been installed. It gets its own clause
      // rather than being folded into a count of problems.
      if ((s.notEnabled ?? 0) > 0) parts.push(`${s.notEnabled} NOT ENABLED`);
      // Defensive, and it should be unreachable: classifyIntegrity only returns
      // incomplete when one of the two is non-zero. Saying "incomplete" with no
      // figures still beats rendering an empty string as though nothing were wrong.
      return (parts.length ? parts.join(", ") : "incomplete, figures not reported") + miner(s) + undeclared(s) + watchdog(s);
    }

    case "unknown":
      // Distinguish "never reported" from "reported too long ago", because they call
      // for different things: one is a unit that was never installed, the other is a
      // unit that has stopped.
      return s.ageSeconds == null
        ? "cannot tell, the box has not reported"
        : `cannot tell, last report ${Math.round(s.ageSeconds / 60)} min old`;
  }
}

/**
 * The strip token, or null when there is nothing to say.
 *
 * Null on `complete` is deliberate and is the only row treated this way. The strip is
 * terse by the user's instruction and already carries seven items, so a permanent
 * "box ok" would cost a slot to tell an operator what they assume. A box that is NOT
 * complete has to be visible without opening the panel, because the panel is a click
 * nobody makes when they think everything is fine.
 */
export function boxChip(s: IntegrityStatus): string | null {
  // Before the complete short-circuit: a box can have every file in place and a
  // watchdog in a restart loop, and that must not be invisible on the terse strip.
  if (watchdogLooping(s)) return "WATCHDOG LOOP";
  if (s.state === "complete") return null;
  return s.state === "incomplete" ? "INCOMPLETE" : "unknown";
}

/** Anything other than a clean report. Matches isIntegrityFailing: unknown counts. */
export function boxIsBad(s: IntegrityStatus): boolean {
  return s.state !== "complete" || watchdogLooping(s);
}
