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
  return n > 0 ? `, ${n} enabled but undeclared` : "";
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
      // surface rather than a fault, and it has been passing the figure through since
      // #338: production answers enabledUndeclared 2 right now. This file never read
      // it, so the one place a person looks said "all enabled" while two enabled units
      // nobody declared went unmentioned. Measured, not deduced, and the layer matters:
      // the API was never the problem.
      return `${s.expected} of ${s.expected} files, all enabled${undeclared(s)}`;

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
      return (parts.length ? parts.join(", ") : "incomplete, figures not reported") + undeclared(s);
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
  if (s.state === "complete") return null;
  return s.state === "incomplete" ? "INCOMPLETE" : "unknown";
}

/** Anything other than a clean report. Matches isIntegrityFailing: unknown counts. */
export function boxIsBad(s: IntegrityStatus): boolean {
  return s.state !== "complete";
}
