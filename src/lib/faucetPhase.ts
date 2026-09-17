/**
 * What phase the faucet is in, from what /api/status said. Pulled out of page.tsx for #573:
 * it was a useCallback inside a "use client" module, so nothing server-rendered could ask it,
 * and a second page deriving its own answer is how the subpages came to contradict the index.
 *
 * The decision MOVES and does not change. readinessBadge.ts turns a phase into a word; this
 * turns the facts into a phase. Together they are the one owner of "what is the faucet doing".
 */
import type { CtazState } from "./crosslink/recency.ts";
import type { MinerReading } from "./miner/heartbeat.ts";
import type { PublicBox } from "./boxLabel.ts";
import type { FaucetNetwork } from "./network.ts";
import type { DripDay } from "../app/Sparkline.tsx";

export type Phase = "checking" | "syncing" | "fault" | "queued" | "empty" | "degraded" | "ready" | "submitting" | "success" | "cooldown" | "error";

// The two states where we cannot send yet, for different reasons: we have not asked,
// or we asked and the node is not ready. They differ in what the page SAYS and agree
// on what it DOES, so every "can we send" test goes through here. Adding "checking"
// without this took the queue path away from anyone who typed inside the first half
// second: basePhase stopped returning "syncing", so the claim fell through to a live
// POST with no proof of work attached, and a hold became an error.
export const holding = (p: Phase) => p === "checking" || p === "syncing" || p === "fault";

export interface Status {
  network: string;
  dripTaz: number;
  cooldownSeconds: number;
  sender: string;
  balanceTaz: number | null;
  empty: boolean;
  queueDepth?: number;
  /** The money-path verdict /api/ready pages on, now on the endpoint the page polls
   * (risk register II, R-32). Optional: a deploy older than this sends none, and absent
   * must read as "not judged", never as healthy. */
  /** `unanswered` is the SUBSET of `unknown` whose z_sendmany reply was lost (#528). Typed here
   *  because the page cannot read a field it does not declare, however real it is at runtime. */
  sends?: { state: "ok" | "degraded" | "unknown"; ok: number; failed: number; unknown: number; unanswered?: number; refused?: number; reason: string };
  /** Drips served: ever, last 7 UTC days, last 30. Null (or absent, from an older
   * deploy) means the ledger would not answer, which is unknown, never zero. */
  // `byDay` is the thirty-day series #549 added: counts only, zero-filled, oldest
  // first. The header sparkline is its first reader on the page.
  drips?: { allTime: number; last7d: number; last30d: number; byDay?: DripDay[] } | null;
  backend: { reachable: boolean; endpoint: string };
  node?: {
    ready: boolean; syncPercent: number | null; height: number | null; nodeHeight: number | null; canBuildTx?: boolean;
    /** Our node stopped following the network: behind an independent tip, or its own
     * tip stalled. Reported since #170; the page never read it, so a frozen node was
     * "syncing, ready shortly" for fourteen hours on 2026-09-07 (risk register II, R-33). */
    frozen?: boolean;
    behind?: boolean;
    externalHeight?: number | null;
    shield?: { state: string; reason?: string | null; lag?: number | null };
    // NULL, not just absent. A wallet that does not answer sends `node: null` - readiness.ts
    // types it that way and faultReason's "our wallet is not answering" branch exists for it.
    // This said `node?: {...}` and denied a value the server demonstrably produces (#573).
  } | null;
  // `active` is derived from the heartbeat now, not from an env flag, so it can
  // finally be false while the miner is broken. `state` is optional because an older
  // deploy answering this shape has no heartbeat to report, and treating a missing
  // field as "running" would be the bug all over again.
  miner?: Partial<MinerReading> & { active: boolean };
  /** The box's own integrity, measured by a unit on the host, as ONE WORD: the page is
   * public and the named faults are the operator's (R-24). Optional: a deploy older
   * than #287 does not send it, and absent must not read as ok. */
  box?: PublicBox;
  reserve?: { targetTaz: number; lowTaz: number; refilling: boolean; spendableTaz: number | null; shieldCoinbase?: boolean; harvesting?: boolean; failedSteps?: number; lastFailure?: { outcome: "waiting" | "resyncing" | "error"; reason: string } | null };
  donationAddress?: string;
  /** Mainnet, for project upkeep. Empty when unset OR rejected by config validation. */
  maintenanceAddress?: string;
  challenge?: "pow" | "none";
  /**
   * cTAZ (#326). Everything above stays TAZ, so nothing here re-points an existing
   * field. Optional because a deploy older than this one sends no block at all, and
   * absent has to read as "this faucet does not offer cTAZ" rather than as an error.
   */
  ctaz?:
    | { enabled: false }
    | {
        enabled: true;
        readiness: CtazState;
        servable: boolean;
        /** Beside the verdict, never inside it. Null is unknown, never 0. */
        syncPercent?: number | null;
        blocks?: number | null;
        tip?: number | null;
        /** "file" | "rpc" | "none": which half to blame when something is wrong. */
        source?: string;
        height: number | null;
        roundLag: number | null;
        finalizers: number | null;
        ageSeconds: number | null;
        /** Their fixed payout, as a decimal string: a bigint does not survive JSON. */
        dripZat: string;
        drips?: { allTime: number; last7d: number; last30d: number; byDay?: DripDay[] } | null;
        /** The literal string. Their surface has no balance method, so this is an
         *  answer rather than a gap, and it must not be rendered as a number. */
        reserve: "unknown";
      };
}

/** Thousands separators, or an en dash when there is no number to show. */
export function num(n: number | null | undefined) { return n == null ? "–" : n.toLocaleString("en-US"); }

// How far the NODE is behind the independent tip, or null when either is unknown.
export const nodeGap = (s: Status): number | null =>
  s.node?.externalHeight != null && s.node.nodeHeight != null && s.node.externalHeight > s.node.nodeHeight
    ? s.node.externalHeight - s.node.nodeHeight
    : null;

// What is wrong, in one sentence a visitor can act on (nothing, mostly), or null when
// nothing is. Each line names the component so the sentence is never "the node" when
// it is the wallet, and never "first sync" when it is a fault.
export const faultReason = (s: Status): string | null => {
  if (!s.backend?.reachable) return "a public indexer we use for balance lookups is unreachable right now";
  // THE WALLET NOT ANSWERING is the most frequent real outage (the zallet crash-loops),
  // and it arrives as node: null AND balanceTaz: null, so every node-guarded line
  // below is silent about it. Readiness calls this "node status unknown"; the page
  // said "first sync takes a while, one time" (review of #522).
  if (s.sender === "zallet" && !s.node) return "our wallet is not answering";
  if (s.node?.frozen) {
    // The distance, not a duration. tipStalledMs is how long THIS PROCESS has seen
    // our tip unchanged; it resets on every deploy and every tip move, so "stopped
    // about 3 minutes ago" after a restart of a node frozen for fourteen hours would
    // be a made-up number. The height gap is measured, from the NODE's tip (the
    // server judges `behind` on nodeHeight; `height` is what the wallet has scanned,
    // which can trail it by more than the network does), and only when distance is
    // what tripped it: a motion stall three blocks from the tip is stuck, not "3
    // blocks behind". The strip shows the same number.
    const gap = nodeGap(s);
    return s.node.behind && gap != null
      ? `our node is ${num(gap)} blocks behind the network`
      : "our node has stopped following the network";
  }
  // Our chain view is too stale to build a drip that could confirm, so hold rather
  // than send one that expires before it is mined (#187). canBuildTx is computed
  // server-side by the gate itself: the browser must not carry a second copy of a
  // money rule, or it diverges the day the rule changes.
  //
  // `=== false` on purpose. A missing field (older server, or a sender the gate
  // does not apply to) must not block a claim, so only an explicit no holds.
  // shield.reason is operator prose (a log line with a semicolon in it) and stays in
  // the panel. Two states: "unsafe" is a measured lag (the #172 born-expired shape)
  // and "unverifiable" is an oracle we could not ask; only the second is "cannot
  // verify".
  if (s.node && s.node.canBuildTx === false) {
    return s.node.shield?.state === "unsafe"
      ? `our node is ${s.node.shield.lag != null ? `${num(s.node.shield.lag)} blocks` : "too far"} behind the network, so a drip sent now would expire before it confirms`
      : "we cannot verify that our node is current, so we are not building transactions";
  }
  if (s.node && s.node.ready !== false && s.balanceTaz == null) return "we cannot read our wallet's balance";
  return null;
};

export function basePhase(s: Status | null, net: FaucetNetwork = "taz"): Phase {
  // Null means we have not asked. Unreachable means we asked and got nothing, which
  // is a real finding about the backend and keeps reading as syncing.
  if (!s) return "checking";

  // cTAZ answers a DIFFERENT set of questions, so it returns before any of the TAZ
  // ones. Not one of them applies: the backend ping is our lightwalletd, the node
  // block is our Zebra, and the balance is our wallet. Their node pays cTAZ out of
  // its own wallet, and the only thing that decides whether it can is the recency
  // gate it reports about itself.
  //
  // There is no "empty" here and that is not an omission. Their surface has no
  // balance method, so we cannot know the wallet is empty, and a faucet that says
  // EMPTY on no evidence is the `balance ?? 0` bug wearing a different hat. A dry
  // node surfaces when a claim comes back refused, which is a true statement made
  // at the moment we have grounds for it.
  if (net === "ctaz") {
    if (!s.ctaz?.enabled) return "syncing";
    return s.ctaz.servable ? "ready" : "syncing";
  }

  // A FAULT IS NOT A SYNC (risk register II, R-33). Every one of these used to render
  // as "Syncing the node. The faucet will be ready shortly... first sync takes a
  // while, one time", with a progress bar near 100%: the frozen node of 2026-09-07 did
  // for fourteen hours, and a public indexer's bad hour was narrated as our node's
  // first sync. The server already tells them apart; the page now does too. Only a
  // node that is genuinely catching up (not ready, not frozen) is "syncing".
  if (faultReason(s)) return "fault";
  if (s.node && s.node.ready === false) return "syncing";
  // No node block at all (a sender the node status does not apply to) and no balance
  // yet: the old reading, a wallet still coming up.
  if (s.balanceTaz == null) return "syncing";
  if (s.balanceTaz <= 0 || s.empty) return "empty";
  // The wallet answers balances and fails sends. Readiness has refused on this since
  // #457 and the watchdog pages on it; the page said LIVE and invited every visitor
  // to solve a proof-of-work into it, escalating per retry. Only a DEFINITE verdict
  // holds: "unknown" is too few sends to judge, and a judgement nobody can make must
  // not close the faucet.
  if (s.sends?.state === "degraded") return "degraded";
  return "ready";
}
