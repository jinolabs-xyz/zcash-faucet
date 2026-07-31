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
 * The panel line. Counts only, never file names: this endpoint is public, and naming
 * what is missing from a production box is reconnaissance. That constraint is #287's
 * and it holds all the way to the screen, not just to the API.
 */
export function boxRow(s: IntegrityStatus): string {
  switch (s.state) {
    case "complete":
      return `${s.expected} of ${s.expected} files, all enabled`;

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
      return parts.length ? parts.join(", ") : "incomplete, figures not reported";
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
