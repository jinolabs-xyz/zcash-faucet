/**
 * How a sync percentage is written, so a number nobody can act on never appears.
 *
 * The bug this exists to remove: `Math.round(syncPercent)` printed "100%" while the
 * node was still catching up, because 99.994 rounds to 100. During the 2026-08-03
 * wallet incident the page showed "Syncing the node" beside a frozen "100%" for
 * minutes, which reads as broken twice over: the label and the number disagree, and
 * the number does not move even though the node is advancing hundreds of blocks.
 *
 * The rule: NEVER show 100% unless the node has actually declared itself ready.
 * Below that, show enough decimals for the figure to change between refreshes,
 * because a progress display whose job is reassurance must visibly progress.
 */

/** Digits chosen so the last blocks of a long sync still move the number. */
export function syncLabel(pct: number | null, ready: boolean): string | null {
  if (pct == null) return null;
  if (ready) return "100%";
  // Not ready: 100 is a lie and 99.99 is the truth. Clamp below 100 rather than
  // round to it, and widen the decimals as the remaining gap narrows, so the
  // final stretch reads 99.94 -> 99.97 -> 99.99 instead of a stuck 100.
  const capped = Math.min(pct, 99.99);
  if (capped >= 99.9) return capped.toFixed(2) + "%";
  if (capped >= 99) return capped.toFixed(1) + "%";
  return Math.floor(capped) + "%";
}

/** The bar's width. Never full while unready, for the same reason. */
export function syncBarWidth(pct: number | null, ready: boolean): string {
  if (pct == null) return "100%"; // indeterminate: the stripe animates instead
  if (ready) return "100%";
  return Math.min(pct, 99.5).toFixed(1) + "%";
}
