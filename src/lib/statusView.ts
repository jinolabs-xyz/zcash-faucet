/**
 * The figures the redesigned Status and Analytics views put on screen.
 *
 * Every function here is pure and takes only what it reads, so the wording can be
 * tested without a browser and without a status object that has to be complete. The
 * views themselves then hold layout and nothing else.
 *
 * ONE RULE RUNS THROUGH ALL OF IT, and it is the house rule the label files next to
 * this one were each written to enforce: a figure we cannot establish reads as unknown,
 * never as zero and never as fine. A null balance is not an empty wallet, an absent
 * height is not a height of zero, and a percentage we have not been given is not 100.
 *
 * The approved preview (redesign-frozen/S2-S5-20260915T1958Z) computes these inline as
 * a `derived` bag. They are ported here rather than transcribed into the view, because
 * three of them disagree with helpers this repo already ships and those disagreements
 * are the interesting part. Each one is marked DEPARTURE below with the reason.
 */
import { minerChip, minerIsBad, readingFromStatus, type MinerUnit } from "./minerLabel.ts";
import type { MinerReading } from "./miner/heartbeat.ts";

/** Thousands separators, the only number formatting these views do. */
export function groupDigits(n: number): string {
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* ── heights ──────────────────────────────────────────────────────────── */

/**
 * Our node's height minus the independent reference.
 *
 * NULL WHEN EITHER SIDE IS MISSING. A missing external reference used to be worth
 * treating as zero somewhere in every version of this page, and the result is a
 * confident "+0 vs network, level" for a node we have nothing to compare against.
 * Level with what?
 */
export function heightDiff(nodeHeight: number | null | undefined, externalHeight: number | null | undefined): number | null {
  if (nodeHeight == null || externalHeight == null) return null;
  return nodeHeight - externalHeight;
}

/** The signed figure beside the big height. Unknown when there is nothing to compare. */
export function heightDeltaText(diff: number | null): string {
  if (diff === null) return "no independent reference";
  const sgn = (diff >= 0 ? "+" : "") + groupDigits(Math.abs(diff) * (diff < 0 ? -1 : 1));
  return sgn + " vs network" + (diff > 0 ? ", ahead" : diff < 0 ? ", behind" : "");
}

/** The sentence under the difference on the network card. */
export function heightNote(diff: number | null): string {
  if (diff === null) return "nothing to compare against";
  if (diff > 0) return "ahead, normal for a node that mines";
  if (diff < 0) return "behind the reference";
  return "level with the reference";
}

/**
 * Whether the height difference is worth marking.
 *
 * Ahead is normal for a node that mines its own blocks, so it is never marked however
 * far ahead it gets. Behind by a block or two is ordinary propagation. Behind by more
 * than two is the shape of the fault that took the faucet down on 2026-09-15, so that
 * is where the colour starts.
 */
export function heightTone(diff: number | null): "ok" | "warn" | "unknown" {
  if (diff === null) return "unknown";
  return diff < -2 ? "warn" : "ok";
}

/* ── sync ─────────────────────────────────────────────────────────────── */

/**
 * The sync figure, to two decimals.
 *
 * DEPARTURE from the preview, and it restores a property this repo already had.
 * syncLabel.ts refuses to print 100% unless the node has declared itself ready, and
 * its test pins the literal case: `syncLabel(100, false)` is "99.99%". That rule was
 * bought during the 2026-08-03 wallet incident, when the page showed a frozen "100%"
 * beside "Syncing the node" for minutes and read as broken twice over.
 *
 * The preview's version is `floor(pct * 100) / 100` with no readiness input at all, so
 * it prints "100.00%" for a node at the tip whose WALLET is still scanning. That is not
 * hypothetical: it is R-43, the state this faucet was in for five hours on 2026-09-15.
 *
 * So this keeps both constraints rather than choosing between them. The owner's ruling
 * is the two decimals; syncLabel's rule is the cap. A ready node at 100 reads
 * "100.00%", an unready node at 100 reads "99.99%", and the badge beside it carries the
 * word.
 *
 * FLOOR, NEVER ROUND, for the same reason syncLabel floors: 99.994 must not round up
 * into a claim the node has not earned.
 */
export function syncFigure(pct: number | null | undefined, ready: boolean): string {
  if (pct == null) return "unknown";
  const floored = Math.floor(pct * 100) / 100;
  if (!ready) return Math.min(floored, 99.99).toFixed(2) + "%";
  return floored.toFixed(2) + "%";
}

/** The bar's width. An unknown percentage fills nothing rather than everything. */
export function syncBarPercent(pct: number | null | undefined, ready: boolean): number {
  if (pct == null) return 0;
  if (ready) return Math.min(100, Math.max(0, pct));
  return Math.min(99.5, Math.max(0, pct));
}

/* ── the wallet ───────────────────────────────────────────────────────── */

/**
 * How many drips the spendable balance is worth, rounded to the nearest hundred.
 *
 * Coarse on purpose, exactly as the preview has it: the figure is a sense of scale, and
 * a number that changes by one every time somebody claims invites a precision it does
 * not have. NULL IN, NULL OUT: an unknown balance buys an unknown number of drips, not
 * zero of them.
 */
export function dripsLeft(spendableTaz: number | null | undefined, dripTaz: number): number | null {
  if (spendableTaz == null || !(dripTaz > 0)) return null;
  return Math.round(spendableTaz / dripTaz / 100) * 100;
}

/** The line under the wallet figure. */
export function dripsLeftText(spendableTaz: number | null | undefined, dripTaz: number): string {
  const drips = dripsLeft(spendableTaz, dripTaz);
  if (drips === null) return "balance unknown";
  return `about ${groupDigits(drips)} drips at ${dripTaz}`;
}

/** The sentence under the reserve bar on the analytics card. */
export function reserveSentence(
  reserve: { spendableTaz?: number | null; targetTaz?: number | null } | null | undefined,
  dripTaz: number,
): string {
  const target = reserve?.targetTaz;
  const line = target == null ? "reserve line unknown" : `reserve line ${groupDigits(target)}`;
  const spendable = reserve?.spendableTaz;
  if (spendable == null) return `spendable balance unknown right now · ${line}`;
  const drips = dripsLeft(spendable, dripTaz);
  const tail = drips === null ? "" : ` · about ${groupDigits(drips)} drips at ${dripTaz}`;
  return `${groupDigits(Math.round(spendable))} TAZ · ${line}${tail}`;
}

/**
 * The reserve's tone: at or under the low mark is bad, under target is a warning.
 *
 * UNKNOWN WHEN THE BALANCE IS NULL, which is the case this exists for. A null balance
 * compared with `<=` reads as 0 <= low and paints the card red for a wallet we simply
 * failed to read. The faucet has been in exactly that state (2026-07-29, balance
 * unknown for hours while the wallet was fine) and a red card would have sent someone
 * to refill a full wallet.
 */
export function reserveTone(
  reserve: { spendableTaz?: number | null; lowTaz?: number | null; targetTaz?: number | null } | null | undefined,
): "ok" | "warn" | "bad" | "unknown" {
  const s = reserve?.spendableTaz;
  if (s == null || reserve?.lowTaz == null || reserve?.targetTaz == null) return "unknown";
  if (s <= reserve.lowTaz) return "bad";
  if (s < reserve.targetTaz) return "warn";
  return "ok";
}

/* ── the miner ────────────────────────────────────────────────────────── */

/**
 * The miner's word, and the single place the view gets it.
 *
 * DEPARTURE from the preview, ruled by the CTO before this was written: the preview
 * carries its own four-line `minerWord`, and it disagrees with minerLabel.ts on nine of
 * the ten states /api/status can actually be in. Three of those are the failure
 * minerLabel.ts was written to prevent, measured rather than argued:
 *
 *   - a WAITING miner, idle on purpose because our node is behind, reads "stalled" in
 *     the preview, which has no branch for it. A fault word over a working guard.
 *   - `box.minerUnit === "inactive"` alone returns "parked", so one stale box report
 *     overrules a LIVE heartbeat. minerLabel.ts requires the heartbeat to agree, and
 *     says why: the heartbeat is the primary evidence.
 *   - "not-configured" and a missing state both read "stalled", so we-are-not-watching
 *     and we-cannot-tell each claim a fault.
 *
 * The preview's first branch also tests `state === "parked"`, a state /api/status has
 * never emitted, so only its box half can ever fire.
 *
 * WHY THIS WRAPPER EXISTS rather than the view calling minerChip directly: it is the one
 * place the view's vocabulary is decided, so a ruling on a word is one line here rather
 * than a search across three cards. The word for a deliberately stopped miner was the
 * open question and the CTO ruled it on 2026-09-15: "parked", not "off". That was
 * applied in minerChip itself rather than mapped here, so the whole app moves at once
 * and one state never has two words.
 */
export function minerWord(
  miner: (Partial<MinerReading> & { active?: boolean }) | null | undefined,
  unit: MinerUnit = null,
): string {
  return minerChip(readingFromStatus(miner), unit);
}

/**
 * The miner's tone, derived from the STATE rather than from the word.
 *
 * Reading a tone off the rendered word would be a proxy for the property: rename a word
 * and the colour silently detaches from the thing it describes. minerIsBad already
 * holds the judgement, including the two cases that look like faults and are not - a
 * miner waiting on a node that is behind, and a miner someone stopped on purpose.
 *
 * "unknown" is its own tone and not a shade of ok. cannot-verify and not-configured
 * mean we are not in a position to say, and grey is how the rest of this page says so.
 */
export function minerTone(
  miner: (Partial<MinerReading> & { active?: boolean }) | null | undefined,
  unit: MinerUnit = null,
): "ok" | "warn" | "bad" | "unknown" {
  const r = readingFromStatus(miner);
  if (r.state === "cannot-verify" || r.state === "not-configured") return "unknown";
  // A unit systemd calls inactive with no heartbeat is a miner someone stopped. Calm,
  // not green: nothing is being mined, and green would say otherwise.
  if (r.state === "not-writing" && unit === "inactive") return "unknown";
  if (r.state === "running") return "ok";
  // AND THE REST IS minerIsBad's CALL, NOT A SECOND ONE MADE HERE. The first version of
  // this function re-derived the judgement with its own `state === "waiting" ? warn :
  // bad`, which was the same answer by a different route - and a mutation pass proved
  // what that costs: deleting the heartbeat half of minerLabel's parked() left every
  // test green, because nothing this file called ever reached it. minerIsBad is where
  // that decision lives and is tested, including the two cases that look like faults and
  // are not, and the one that looks calm and is not: a node with NO PEERS, where the
  // miner row is the only place that fault can show.
  return minerIsBad(r, unit) ? "bad" : "warn";
}

/** Accepted as a share of everything submitted. Null when nothing has been submitted. */
export function acceptPercent(miner: { submittedAccepted?: number | null; submittedRejected?: number | null } | null | undefined): number | null {
  const a = miner?.submittedAccepted, r = miner?.submittedRejected;
  if (a == null && r == null) return null;
  const total = (a ?? 0) + (r ?? 0);
  if (total === 0) return null;
  return Math.round(((a ?? 0) / total) * 100);
}

/**
 * The sentence under the miner bar.
 *
 * "no blocks submitted yet" rather than "0% accepted by our node". A faucet whose miner
 * has submitted nothing has no acceptance rate, and 0% is a claim about a rate we have
 * not measured. The two states look identical at 0 and are not the same news.
 */
export function acceptSentence(miner: { submittedAccepted?: number | null; submittedRejected?: number | null } | null | undefined): string {
  const pct = acceptPercent(miner);
  if (pct === null) return "no blocks submitted yet";
  return `${pct}% accepted by our node`;
}

/* ── the backend ──────────────────────────────────────────────────────── */

/**
 * The backend host as the card shows it, without its scheme.
 *
 * The scheme is dropped for width, not for secrecy, and nothing else is removed: the
 * port stays, because testnet.zec.rocks:443 and testnet.zec.rocks:9067 are different
 * answers when someone is working out why a lookup fails.
 */
export function backendHost(endpoint: string | null | undefined): string {
  if (!endpoint) return "unknown";
  return endpoint.replace(/^https?:\/\//, "");
}
