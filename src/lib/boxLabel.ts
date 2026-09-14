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
 *
 * WHAT THE PUBLIC PAGE SAYS IS ONE WORD (risk register II, R-24). This file used to
 * render "WATCHDOG STOPPED, nothing heals" and "CANNOT PAGE" on the public strip, which
 * told anyone who looked exactly when the box could neither heal nor summon a person.
 * The verdict still reaches the page, as ATTENTION, so the one channel that survives a
 * dead pager still says something; the detail (which fault) goes to the operator through
 * the Signal page, the box's own report, and the token-gated /api/status the off-box
 * probe reads. The predicates below are that verdict; the public words are at the end.
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

/** The watchdog is not running, by systemd's word: stopped by someone, failed, or on
 *  its way down. Nothing heals a container, a poisoned wallet or a stalled node while it
 *  is down, and nothing else on the box would say so (register #16); the unit's own
 *  OnFailure page still fires through systemd, but the watchdog's sweeps and their FIXED
 *  and NEEDS YOU reports do not. "unknown", "activating" and null are not this fault:
 *  could-not-tell is the off-box probe's to fail, and a unit mid-restart is seconds from
 *  running. */
export function watchdogStopped(s: IntegrityStatus): boolean {
  return s.watchdogUnit === "inactive" || s.watchdogUnit === "failed" || s.watchdogUnit === "deactivating";
}

/** The box cannot page anyone, by its own report: the Signal bridge is down, the
 *  account is not linked on it, the configuration is one alert.sh refuses to send with,
 *  or no alert URL is configured at all. A fault, and one nothing else can show, because
 *  every alert about it would travel through the thing that is broken. "ok", "webhook", "unknown" and null are not faults here; "unknown"
 *  is the off-box probe's to fail, since a public row cannot tell "could not ask" from
 *  "asked and it is down" without inviting a reader to ignore red. */
export function alertBridgeDown(s: IntegrityStatus): boolean {
  return s.alertBridge === "down" || s.alertBridge === "unlinked" || s.alertBridge === "none" || s.alertBridge === "misconfigured";
}

/** Anything other than a clean report. Matches isIntegrityFailing, plus the three faults only the report can carry: a looping watchdog, a stopped one, and a box that cannot page; unknown counts. */
export function boxIsBad(s: IntegrityStatus): boolean {
  return s.state !== "complete" || watchdogLooping(s) || watchdogStopped(s) || alertBridgeDown(s);
}

/** What the public page is told about the box: one word (R-24). "unknown" is a report
 *  that is missing or stale, which the off-box probe fails on and the page must not
 *  read as fine; "attention" is any fault the detail-bearing predicates above would
 *  name; "ok" is a complete box with a running watchdog and a working pager. */
export type PublicBoxState = "ok" | "attention" | "unknown";
export interface PublicBox {
  state: PublicBoxState;
  /** systemd's word for the miner unit, passed through: the miner panel uses it to tell a
   *  parked miner from a dead one, and the miner strip already says which. */
  minerUnit: string | null;
}

export function publicBox(s: IntegrityStatus): PublicBox {
  return {
    state: s.state === "unknown" ? "unknown" : boxIsBad(s) ? "attention" : "ok",
    minerUnit: s.minerUnit,
  };
}

/** The strip's one slot. Nothing for ok: a permanent "box ok" would spend the slot on
 *  what an operator already assumes; anything else has to be visible without a click. */
export function publicBoxChip(b: PublicBox): string | null {
  switch (b.state) {
    case "ok": return null;
    case "attention": return "OPS ATTENTION";
    default: return "unknown";
  }
}

/** The panel row. Names no fault: the operator has the box's report and the page; a
 *  visitor needs to know only that the people running it have something to look at. */
export function publicBoxRow(b: PublicBox): string {
  switch (b.state) {
    case "ok": return "ok, everything the repo requires is installed and running";
    case "attention": return "needs the operator's attention (detail is on the box, not here)";
    default: return "unknown, the box has not reported recently";
  }
}

export function publicBoxIsBad(b: PublicBox): boolean {
  return b.state !== "ok";
}
