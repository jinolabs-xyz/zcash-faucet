/**
 * What the panel says about the miner.
 *
 * Same job as reserveLabel.ts and the same failure it exists to prevent. "miner on"
 * was doing what "257.2 / 1000, idle" was doing: sounding fine while saying nothing.
 * It read "on" for 70 minutes while the miner errored every 5 seconds, because it was
 * an env flag and an env flag cannot be false while something is broken.
 *
 * The rule every line here follows: NONE OF THE BAD STATES MAY READ AS NORMAL, and
 * "we cannot tell" must not read as either "fine" or "off". Those are three different
 * claims. Pure and exported so the wording is testable without a browser.
 */
import type { MinerReading, MinerState } from "./miner/heartbeat.ts";

/**
 * Turn whatever /api/status sent into a reading the renderers can trust.
 *
 * WHY A MISSING `state` IS cannot-verify. A deploy older than this change answers with
 * the old `{ active }` shape and no state at all. Defaulting that to "running", or
 * deriving it from `active`, would rebuild the exact bug: a field that cannot report a
 * broken miner. An absent state means this page is talking to something that cannot
 * tell us, which is what cannot-verify says.
 */
export function readingFromStatus(m: (Partial<MinerReading> & { active?: boolean }) | null | undefined): MinerReading {
  const state: MinerState =
    m?.state === "running" || m?.state === "stalled" || m?.state === "not-writing" || m?.state === "not-configured"
      ? m.state
      : "cannot-verify";
  return {
    state,
    beatAgoSeconds: m?.beatAgoSeconds ?? null,
    templateAgoSeconds: m?.templateAgoSeconds ?? null,
    lastTemplateHeight: m?.lastTemplateHeight ?? null,
    mode: m?.mode ?? null,
    lastErrorStage: m?.lastErrorStage ?? null,
    consecutiveErrors: m?.consecutiveErrors ?? null,
  };
}

/**
 * Coarse durations on purpose. The panel is a readout, not a stopwatch, and a value
 * that changes every render invites reading precision into a number that does not
 * have it.
 */
export function humanAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const min = Math.round(seconds / 60);
  if (min < 90) return `${min} min`;
  return `${Math.round(min / 6) / 10} h`;
}

const groupDigits = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * The short token for the top status strip, which stays terse per the user. Bad states
 * still have to be legible here: "off" would be a lie for a stalled miner, since it is
 * running and failing, and those need different responses from an operator.
 */
export function minerChip(r: MinerReading): string {
  switch (r.state) {
    // Terse is not licence to overstate. A proposal-mode miner never submits a solved
    // block, so "mining" here would claim we are trying to win blocks while the panel
    // one click away says we are not.
    case "running": return r.mode === "proposal" ? "proposing" : "mining";
    case "stalled": return "no blocks";
    case "not-writing": return "no signal";
    case "cannot-verify": return "unknown";
    // Not softened to blank. We are not watching the miner, and a reader who sees
    // nothing here would conclude there was nothing to know.
    case "not-configured": return "unwatched";
  }
}

/**
 * The panel line. This is where the detail belongs, per the user: he asked that the
 * miner's real state be knowable from More details.
 */
export function minerRow(r: MinerReading): string {
  const at = r.lastTemplateHeight != null ? ` at ${groupDigits(r.lastTemplateHeight)}` : "";

  switch (r.state) {
    case "running": {
      const age = r.templateAgoSeconds != null ? humanAge(r.templateAgoSeconds) : "unknown";
      // Proposal mode never submits a solved block, so calling it "mining" would claim
      // we are trying to win blocks when we are only asking for templates.
      const verb = r.mode === "proposal" ? "proposing only" : "mining";
      return `${verb}, last template ${age} ago${at}`;
    }

    // The today case, and the one that must not sound survivable. Naming the age is
    // the whole point: "no template" alone reads like a quiet minute.
    case "stalled":
      return r.templateAgoSeconds == null
        ? "NO TEMPLATE since the miner started"
        : `NO TEMPLATE in ${humanAge(r.templateAgoSeconds)}${at ? `, last${at}` : ""}`;

    // The writer stopped. Distinct from stalled because the fault is elsewhere: the
    // unit is down, wedged, or the disk is full, and the miner itself may be fine.
    case "not-writing":
      return r.beatAgoSeconds != null
        ? `NO HEARTBEAT for ${humanAge(r.beatAgoSeconds)}, miner state unknown`
        : "NO HEARTBEAT, miner state unknown";

    // Never "off". We have not established that it is off, only that we cannot see it.
    case "cannot-verify":
      return "cannot tell, heartbeat configured but unreadable";

    // Says whose problem it is. "Cannot tell" alone sent a reader looking for a
    // broken miner when the answer is an unset variable on the deploy, which is a
    // different job at a different time of day.
    case "not-configured":
      return "not watched, no heartbeat path configured";
  }
}

/**
 * The error line, shown only when there is one to show.
 *
 * Deliberately separate from the state, because errors do NOT decide the state: a
 * counter can read zero while nothing works, which is how we got here. A stage token
 * rather than a message, because the miner's raw error text is the transport's and can
 * carry the RPC URL, which can carry credentials in its userinfo, and this endpoint is
 * public.
 */
export function minerErrorRow(r: MinerReading): string | null {
  if (!r.lastErrorStage) return null;
  const n = r.consecutiveErrors ?? 0;
  return n > 1 ? `${r.lastErrorStage} failing, ${n} in a row` : `last error in ${r.lastErrorStage}`;
}
