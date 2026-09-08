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
    m?.state === "running" || m?.state === "waiting" || m?.state === "stalled" || m?.state === "not-writing" || m?.state === "not-configured"
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
    solvedCount: m?.solvedCount ?? null,
    submittedAccepted: m?.submittedAccepted ?? null,
    submittedRejected: m?.submittedRejected ?? null,
    solvedAgoSeconds: m?.solvedAgoSeconds ?? null,
    nodeLag: m?.nodeLag ?? null,
    waitingAgoSeconds: m?.waitingAgoSeconds ?? null,
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

/** systemd's word for the miner unit, from the box report: "active", "inactive",
 *  "failed", "unknown", or null/undefined when the report predates the field. */
export type MinerUnit = string | null | undefined;

/** A heartbeat nobody is writing AND a unit systemd calls inactive: stopped on purpose.
 *  Only that pairing. The heartbeat is the primary evidence, so a fresh one is never
 *  overruled by the word, and no word at all proves nothing. */
function parked(r: MinerReading, unit: MinerUnit): boolean {
  return r.state === "not-writing" && unit === "inactive";
}

/**
 * The short token for the top status strip, which stays terse per the user. Bad states
 * still have to be legible here: "off" would be a lie for a stalled miner, since it is
 * running and failing, and those need different responses from an operator.
 *
 * "off" IS available now, for exactly one case: the heartbeat has stopped AND systemd
 * says the unit is inactive. That is a miner someone stopped, not one that died. The
 * strip read "no signal" and the panel shouted NO HEARTBEAT in red for hours over a
 * unit that was parked on purpose (2026-09-08), which teaches a reader that red means
 * nothing. A unit systemd calls failed stays red, with its own word.
 */
export function minerChip(r: MinerReading, unit: MinerUnit = null): string {
  switch (r.state) {
    // Terse is not licence to overstate. A proposal-mode miner never submits a solved
    // block, so "mining" here would claim we are trying to win blocks while the panel
    // one click away says we are not.
    case "running": return r.mode === "proposal" ? "proposing" : "mining";
    // Not "mining" and not "no blocks": the miner is fine and idle by its own decision,
    // because the node is behind. The node row two cells away carries the fault.
    case "waiting": return "waiting";
    case "stalled": return "no blocks";
    case "not-writing":
      if (parked(r, unit)) return "off";
      return unit === "failed" ? "unit failed" : "no signal";
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
/**
 * Whether this miner has ever actually WON anything (#408).
 *
 * The row above says "mining", which means the process is alive and fetching templates.
 * A miner that has fetched forty thousand templates and solved nothing renders exactly
 * like one that won a block a minute ago, and the box has known the difference since
 * #286 - the heartbeat has carried solvedCount all along and nothing read it.
 *
 * It cost real time: the owner asked twice whether mining was working, and the answer
 * had to be assembled by hand from journald. The watcher written to answer it grepped
 * for log lines zebra never emits and reported zero wins for ten minutes after a block
 * had been won. This field was sitting in the file the whole time.
 *
 * NULL RENDERS NOTHING, and never "0 blocks". A heartbeat that predates the counter and
 * a miner that has genuinely never won are different claims, and only one of them is
 * about the miner.
 *
 * THE COUNT IS PER PROCESS, NOT LIFETIME, and the row must not imply otherwise. The
 * miner holds it in memory, so a restart resets it to zero - which is why this says
 * "won" with a time rather than "has won N in total". A deploy that restarts the miner
 * makes a busy day read as a fresh one, and a row claiming a lifetime total it does not
 * have would be worse than no row. Observed straight after writing this: the box read 1
 * within minutes of a restart, having won many more before it.
 *
 * REJECTIONS COME FIRST when there are any. A miner that solves and is REFUSED is
 * failing in the way that looks like success at every other layer: alive, fetching,
 * solving, and none of it counted.
 */
function wins(r: MinerReading): string {
  const solved = r.solvedCount;
  if (solved == null) return "";
  if (solved === 0) return ", no blocks won yet";

  const ago = r.solvedAgoSeconds != null ? ` ${humanAge(r.solvedAgoSeconds)} ago` : "";
  const rejected = r.submittedRejected ?? 0;
  const blocks = `${solved} block${solved === 1 ? "" : "s"} won`;
  return rejected > 0
    ? `, ${blocks}${ago}, ${rejected} REJECTED`
    : `, ${blocks}${ago}`;
}

export function minerRow(r: MinerReading, unit: MinerUnit = null): string {
  const at = r.lastTemplateHeight != null ? ` at ${groupDigits(r.lastTemplateHeight)}` : "";

  switch (r.state) {
    case "running": {
      const tmpl = r.templateAgoSeconds != null ? `template ${humanAge(r.templateAgoSeconds)} ago` : "template age unknown";
      // Proposal mode never submits a solved block, so calling it "mining" would claim
      // we are trying to win blocks when we are only asking for templates.
      const verb = r.mode === "proposal" ? "proposing only" : "mining";
      // NO HEIGHT HERE, deliberately. The panel already carries `block height` two
      // cells away, and repeating it pushed this row onto a second line for a number
      // the reader can already see. The healthy row's job is to say we are working
      // and how recently; a wrapped row costs more attention than the digits buy.
      //
      // The FAILING rows below keep the height, because there the two numbers differ
      // and that gap is the finding: a miner stuck at a height the node has left
      // behind is exactly what a stale template looks like.
      return `${verb}, ${tmpl}${wins(r)}`;
    }

    // Idle on purpose. Says why, in the node's own terms, so nobody restarts a miner that
    // is doing the one thing that keeps it off a fork. The age says how long the node has
    // been behind, which is the number an operator actually wants.
    case "waiting": {
      const behind = r.nodeLag != null ? `node ${groupDigits(r.nodeLag)} blocks behind` : "node behind";
      const since = r.waitingAgoSeconds != null ? ` for ${humanAge(r.waitingAgoSeconds)}` : "";
      return `waiting, ${behind}${since}`;
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
      // Stopped on purpose reads calm. A unit systemd calls failed reads as the fault
      // it is. A unit systemd calls active with a dead heartbeat is a wedged writer,
      // which is the original NO HEARTBEAT case and keeps its alarm.
      if (parked(r, unit)) return "off, unit stopped";
      if (unit === "failed") return "unit FAILED";
      return r.beatAgoSeconds != null ? `NO HEARTBEAT ${humanAge(r.beatAgoSeconds)}` : "NO HEARTBEAT";

    // Never "off". We have not established that it is off, only that we cannot see it.
    case "cannot-verify":
      return "cannot read heartbeat";

    // Says whose problem it is. "Cannot tell" alone sent a reader looking for a
    // broken miner when the answer is an unset variable on the deploy, which is a
    // different job at a different time of day.
    case "not-configured":
      return "not watched, no heartbeat path";
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
export function minerErrorRow(r: MinerReading, unit: MinerUnit = null): string | null {
  if (!r.lastErrorStage) return null;
  // A parked miner's last error is the last thing it saw before someone stopped it, a
  // count frozen in a file nobody writes. "1975 in a row" under an "off" row reads as
  // a live fault, so it is not shown. Under a unit systemd calls active it IS live.
  if (parked(r, unit)) return null;
  const n = r.consecutiveErrors ?? 0;
  return n > 1 ? `${r.lastErrorStage} failed ${n}× in a row` : `${r.lastErrorStage} failed once`;
}

/**
 * Whether the miner row is marked. Running is fine; a miner stopped on purpose is fine
 * and must not be red, or red stops meaning anything; everything else is a finding.
 */
export function minerIsBad(r: MinerReading, unit: MinerUnit = null): boolean {
  // Waiting is the guard working. The node row is where a node that is behind reads red;
  // marking the miner too would teach a reader that two rows go red for one fault.
  if (r.state === "running" || r.state === "waiting") return false;
  return !parked(r, unit);
}
