/**
 * What the miner is ACTUALLY doing, as opposed to what an operator configured.
 *
 * `/api/status` used to report `miner.active` straight from FAUCET_MINER_ACTIVE, an
 * env flag. That reports intent, not behaviour, and it can never be false while the
 * miner is broken. On 2026-07-31 it read "on" for 70 minutes while the miner errored
 * every five seconds on getblocktemplate, because zebra had regenerated its auth
 * cookie on restart and the miner still held the old one. The process was alive and
 * the unit was `active` the whole time. Only the templates had stopped.
 *
 * So the signal is TEMPLATE ACTIVITY, not process liveness. Anything keyed on "is it
 * running" rebuilds the same false pass one layer down.
 *
 * Pure, so every state is reachable in a test without a miner, a node, or a box.
 */

/** Beyond this with no new template, the miner is not doing its job. */
export const STALE_AFTER_MS = 3 * 60_000;

/**
 * A template roughly every few seconds is normal, so three minutes is many missed
 * cycles rather than one unlucky gap. Long enough that a slow node or a brief zebra
 * restart does not cry wolf; short enough that today's 70-minute outage would have
 * been visible within three.
 */

export type MinerState =
  | "mining" // producing templates now
  | "stalled" // configured on, alive, but no template for too long
  | "off" // deliberately not mining
  | "unknown"; // no heartbeat to read, so we cannot say

export interface MinerHeartbeat {
  /** Height of the most recent block template the miner fetched. */
  height: number | null;
  /** Epoch ms when that template was seen. */
  at: number | null;
  /** Whether the writer could read the miner's activity at all. */
  readable: boolean;
}

export interface MinerStatus {
  state: MinerState;
  /** Seconds since the last template, or null when we have none. */
  lastTemplateAgoSeconds: number | null;
  height: number | null;
  /** Plain sentence for the panel. Never claims more than the state supports. */
  reason: string;
}

/**
 * `configuredOn` is FAUCET_MINER_ACTIVE. It is kept ONLY to tell "off on purpose"
 * apart from "should be mining and is not". It is never evidence that mining is
 * happening, which is the mistake this module exists to correct.
 */
export function classifyMiner(
  hb: MinerHeartbeat | null,
  configuredOn: boolean,
  now: number,
): MinerStatus {
  if (!configuredOn) {
    return {
      state: "off",
      lastTemplateAgoSeconds: null,
      height: null,
      reason: "mining is switched off for this deployment",
    };
  }

  // No file, or a writer that could not read the miner. NOT "off": we were told to
  // mine and cannot see whether we are. Absence of evidence is the one thing this
  // must never render as good news.
  if (!hb || !hb.readable || hb.at === null) {
    return {
      state: "unknown",
      lastTemplateAgoSeconds: null,
      height: null,
      reason:
        "mining is switched on, but no heartbeat could be read, so whether it is " +
        "actually producing templates is unverified",
    };
  }

  const ageMs = Math.max(0, now - hb.at);
  const ago = Math.round(ageMs / 1000);

  if (ageMs > STALE_AFTER_MS) {
    return {
      state: "stalled",
      lastTemplateAgoSeconds: ago,
      height: hb.height,
      reason:
        `mining is switched on but the last block template was ${fmt(ago)} ago. ` +
        "The miner process can be alive and still not be mining: that is what a " +
        "stale RPC cookie looks like",
    };
  }

  return {
    state: "mining",
    lastTemplateAgoSeconds: ago,
    height: hb.height,
    reason: hb.height
      ? `producing templates, last one ${fmt(ago)} ago at height ${hb.height.toLocaleString("en-US")}`
      : `producing templates, last one ${fmt(ago)} ago`,
  };
}

function fmt(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/** Only a state we have positively established as bad. `unknown` is not a fault. */
export function isMinerProblem(s: MinerStatus): boolean {
  return s.state === "stalled";
}
