"use client";

import { CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
// The redesign's tokens and shell, transcribed from the preview the owner approved on
// 2026-09-15. Tokens first: the shell reads them.
/* KEEP-BOTH, and the two sides removed different things rather than disagreeing.
 *
 * #567 deleted the legacy status strip, so `reserveRows`, the five `minerLabel` helpers and the
 * three `publicBoxRow`/`Chip`/`IsBad` calls have no caller here any more - only the type
 * survives. #576 moved the chrome into the Shell, so `BrandMark`, `Link` and the `Sparkline`
 * COMPONENT went with it, and only the `DripDay` type is still needed. Verified by counting
 * each symbol's uses in the merged body rather than by reasoning about it: every one of those
 * twelve appears exactly once, on its own import line and nowhere else.
 *
 * THE STYLESHEETS MOVED TO THE SHELL and `redesign-views.css` was about to be left behind:
 * Shell.tsx imports tokens, shell, hero and subpages, and the views sheet was imported by this
 * file alone. Dropping it here without adding it there would have shipped the three views
 * unstyled, with nothing failing at build time. It is in the Shell now, beside the other four. */
import type { DripDay } from "./Sparkline";
import { Mascot } from "@/components/Mascot";
import { Shell } from "@/components/Shell";
import { StatusCards } from "@/components/StatusCards";
import { AnalyticsCards } from "@/components/AnalyticsCards";
import { ToolsCards } from "@/components/ToolsCards";
import type { PublicBox } from "@/lib/boxLabel";
import { syncLabel, syncBarWidth } from "@/lib/syncLabel";
import { networkFacts, formatAmount, type FaucetNetwork } from "@/lib/network";
import { incomeSentence } from "@/lib/incomeSentence";
import { validateTestnetAddress } from "@/lib/zcash/address";
import { powEstimateSeconds, powEstimateText } from "@/lib/powEstimate";
import type { CtazState } from "@/lib/crosslink/recency";
import type { MinerReading } from "@/lib/miner/heartbeat";

/* ── Types ─────────────────────────────────────────────────────────────── */
// "checking" is NOT a variant of "syncing". It means we have not asked the backend
// yet, and the page renders in 2ms while /api/status takes 460 to 770ms, so this
// state is on screen for over half a second on localhost and longer over a network.
// It used to render as "syncing", which told a first-time visitor that a healthy
// faucet was busy coming up.
// The four sections behind the segmented nav. One is visible at a time and the rest
// carry `hidden`, which the shell turns into display:none. The hash mirrors it so a
// view survives a reload and can be linked to.
type View = "claim" | "status" | "analytics" | "tools";
const VIEWS: View[] = ["claim", "status", "analytics", "tools"];

// Names the card's own height animation so the effect can cancel ITS animation and nobody
// else's - the mascot and the entrance animations share this document.
const CARD_HEIGHT_ANIM = "card-height";

type Phase = "checking" | "syncing" | "fault" | "queued" | "empty" | "degraded" | "ready" | "submitting" | "success" | "cooldown" | "error";

// The two states where we cannot send yet, for different reasons: we have not asked,
// or we asked and the node is not ready. They differ in what the page SAYS and agree
// on what it DOES, so every "can we send" test goes through here. Adding "checking"
// without this took the queue path away from anyone who typed inside the first half
// second: basePhase stopped returning "syncing", so the claim fell through to a live
// POST with no proof of work attached, and a hold became an error.
const holding = (p: Phase) => p === "checking" || p === "syncing" || p === "fault";

interface Status {
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
  sends?: { state: "ok" | "degraded" | "unknown"; ok: number; failed: number; unknown: number; reason: string };
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
  };
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
type CopyTarget = "txid" | "receipt" | "donation" | "key";
/**
 * A completed drip.
 *
 * `txid` IS OPTIONAL, and everything the receipt says about a missing one is driven by
 * this field being absent, never by which network was picked. The API leaves the key
 * out when the network returned none, so the page reads what happened. A `network`
 * field here would be enough to render "no transaction id" for cTAZ even on a response
 * that carried one, which is the difference between reporting and predicting.
 *
 * `network` is still here, for the WORDING of the explanation and the ticker, and it
 * is only ever consulted once the absence has already been established.
 */
interface Tx { txid?: string; to: string; priv: boolean; explorerUrl?: string; at: number; network: FaucetNetwork; amountText: string }

/**
 * The receipts THIS BROWSER was handed, so a cooldown can show the drip that already went
 * out without asking the server to repeat it.
 *
 * WHY NOT ASK THE SERVER. A first cut had the 429 return the txid that paid the address,
 * and review showed what that is: an oracle. Anyone who knows address X can POST it with
 * one solved proof-of-work and learn which transaction paid X, which for a shielded
 * recipient is a link the chain itself does not reveal. PRIVACY.md refuses to build that
 * record. The browser that made the claim already received the txid in its own 200; it
 * can remember its own receipt. Same device, same browser, and nothing new stored on our
 * side - which is also the case that actually happened: paid, retried from the same tab a
 * hundred seconds later, told "come back tomorrow" with no mention of the payment.
 *
 * Keyed by NETWORK AND address, capped small, and expired past the cooldown on both
 * write and read: it exists to answer "did this address just get paid here, in this
 * asset", not to be a history. Two review findings shaped that sentence. Keyed by address
 * alone, a cTAZ receipt overwrote the TAZ one and the TAZ card read "got its 0.5 cTAZ" -
 * the exact wrong sentence this page once removed. And pruned only on write, a receipt
 * from days ago was presented as the payment behind TODAY's block, which may have been
 * someone else's claim of the same address entirely.
 */
const RECEIPTS_KEY = "zfaucet_receipts";
const RECEIPTS_MAX = 8;
interface Receipt { txid?: string; explorerUrl?: string; at: number; network: FaucetNetwork; amountText: string }
const receiptKey = (network: FaucetNetwork, address: string) => `${network}:${address.trim().toLowerCase()}`;
function readReceipts(ttlMs: number): Record<string, Receipt> {
  try {
    const raw = localStorage.getItem(RECEIPTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Receipt>) : {};
    if (typeof parsed !== "object" || !parsed) return {};
    const cutoff = Date.now() - ttlMs;
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v && typeof v.at === "number" && v.at >= cutoff));
  } catch {
    return {};
  }
}
function rememberReceipt(network: FaucetNetwork, address: string, r: Receipt, ttlMs: number) {
  try {
    const kept = Object.entries(readReceipts(ttlMs));
    kept.push([receiptKey(network, address), r]);
    const trimmed = kept.slice(-RECEIPTS_MAX);
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // Storage blocked or full: the receipt is still on screen right now, and a cooldown
    // without it degrades to the wording alone, which is still true.
  }
}
interface PowSolution { seed: string; difficulty: number; exp: number; sig: string; nonce: string }

/**
 * How long we hold a claim waiting for our chain view to get fresh enough to build a
 * drip that can confirm. Roughly twelve testnet blocks: ordinary lag of a few blocks
 * clears well inside it, and a node still behind after this long is not going to be
 * fixed by making the user wait more quietly.
 */
const HOLD_MAX_MS = 15 * 60_000;

/* ── Helpers ───────────────────────────────────────────────────────────── */

function detect(raw: string) {
  const a = (raw || "").trim();
  const l = a.toLowerCase();
  if (!a) return { kind: "none" as const };
  if (l.startsWith("utest1")) return { kind: "ok" as const, label: "Unified · shielded", priv: true, min: 40 };
  if (l.startsWith("ztestsapling")) return { kind: "ok" as const, label: "Sapling · shielded", priv: true, min: 60 };
  if (/^t[m2]/.test(l)) return { kind: "ok" as const, label: "Transparent · public", priv: false, min: 34 };
  if (/^(u1|zs1|t1|t3)/.test(l)) return { kind: "mainnet" as const };
  return { kind: "unknown" as const };
}
function check(addr: string) {
  const a = addr.trim();
  const d = detect(a);
  if (d.kind === "none") return { ok: false as const };
  if (d.kind === "mainnet")
    return { ok: false as const, err: "That's a mainnet address. This faucet only sends testnet TAZ. Testnet addresses start with utest1, ztestsapling or tm." };
  if (d.kind === "unknown")
    return { ok: false as const, err: "Not a Zcash testnet address. It should start with utest1 (unified), ztestsapling (Sapling) or tm (transparent)." };
  if (a.length < d.min)
    return { ...d, ok: false as const, err: "That address looks cut short: " + a.length + " of about " + d.min + " characters." };
  // The server decodes the checksum too, but by then the browser has solved a proof of
  // work for nothing (risk register II, R-38): an address one character off cost a
  // full solve and came back a 400. Same decoder as the route, same sentences, before
  // any hashing. Pure JS on @scure/base and @noble/hashes; those were server-only
  // before, so this is about 7 KB gzipped more on the first load of /, which a wasted
  // solve costs a phone many times over.
  const info = validateTestnetAddress(a);
  if (!info.valid) return { ...d, ok: false as const, err: info.reason ?? "That address does not decode. Re-copy it from your wallet." };
  return { ...d, ok: true as const };
}
function short(a: string, h: number, t: number) { return !a ? "" : a.length <= h + t + 1 ? a : a.slice(0, h) + "…" + a.slice(-t); }
function dur(ms: number) {
  if (ms <= 0) return "a moment";
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + s + "s";
  return s + "s";
}
function num(n: number | null | undefined) { return n == null ? "–" : n.toLocaleString("en-US"); }

/**
 * Sun and moon for the theme toggle. Inline rather than an icon dependency: two
 * shapes do not justify a package, and `currentColor` lets them inherit the
 * button's hover and focus states for free.
 *
 * Each shows the theme you would GET, not the one you are in, which is what a
 * reader reaching for a toggle is looking for. The aria-label says the action out
 * loud because an icon alone does not.
 */

const muted = (pct: number): string => `color-mix(in srgb, var(--color-text) ${pct}%, transparent)`;
const PROOF_SECONDS = 12; // estimated shielded-proof build time, for the progress feel

// Receipt confirmation poll. 10s is 6/min per open receipt, which is what the
// /api/tx limiter's 60/min default was sized around (#101), so two or three tabs
// behind one NAT still fit. Deep enough to stop at: a drip is not a large payment
// and the number only goes up from here.
const TX_POLL_MS = 10_000;
const CONFIRMATIONS_ENOUGH = 6;
// Rejection value of a solve the visitor cancelled; compared by identity, never a message.
const POW_CANCELLED = new Error("pow cancelled");

/* ── Component ─────────────────────────────────────────────────────────── */
// Pure functions of a status reply, outside the component so basePhase's useCallback
// closes over nothing that can go stale.
// Where the TAZ comes from, from the same facts the panel shows (R-39). Null until the
// first status lands, so no sentence is rendered on a guess.
const harvestFailing = (s: Status): boolean =>
  s.reserve?.lastFailure?.outcome === "error" && (s.reserve.failedSteps ?? 0) > 0;
const incomeFrom = (s: Status | null): string | null =>
  s?.miner && s.reserve
    ? incomeSentence({ minerActive: s.miner.active, accepted: s.miner.submittedAccepted ?? null, shieldCoinbase: s.reserve.shieldCoinbase === true, harvestFailing: harvestFailing(s) })
    : null;
// How far the NODE is behind the independent tip, or null when either is unknown.
const nodeGap = (s: Status): number | null =>
  s.node?.externalHeight != null && s.node.nodeHeight != null && s.node.externalHeight > s.node.nodeHeight
    ? s.node.externalHeight - s.node.nodeHeight
    : null;
// What is wrong, in one sentence a visitor can act on (nothing, mostly), or null when
// nothing is. Each line names the component so the sentence is never "the node" when
// it is the wallet, and never "first sync" when it is a fault.
const faultReason = (s: Status): string | null => {
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

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  // THE CARD ANIMATES ITS OWN HEIGHT AND NOTHING OUTSIDE IT MOVES (owner ruling, 18:56Z),
  // animated the way the frozen preview animates it rather than through motion's `layout`.
  //
  // WHY NOT `layout`, WITH THE MEASUREMENT THAT DECIDED IT. `motion.article layout` works and
  // the sweep goes green on it, but it costs a tap target: ui-smoke's mobile receipt check
  // drops to 147/1 with the prop and is 148/0 without it, isolated by removing that one line
  // and changing nothing else. A layout animation interpolates the box and the controls inside
  // it measure just under the 44px floor while it runs. 43.9 is not a number a person notices;
  // an accessibility floor that holds except during an animation is still a floor that does not
  // hold, and this one had held at exactly 44.000 before.
  //
  // So it animates `height` directly, which is what the preview does (460ms,
  // cubic-bezier(.16,1,.3,1)) and therefore what the owner was watching when they ruled. The
  // box is the only thing that moves; nothing inside it is interpolated, so nothing inside it
  // is measured wrong.
  //
  // Reduced motion is read in JS rather than left to the stylesheet, and that distinction is
  // the point: globals.css:264 and redesign-shell.css:142 both kill `animation` and
  // `transition` under prefers-reduced-motion, and a Web Animations API animation is NEITHER.
  // It would sail straight through both rules and play for exactly the people who asked it not
  // to.
  const cardRef = useRef<HTMLElement | null>(null);
  const cardFrom = useRef<number | null>(null);
  const cardAnim = useRef<Animation | null>(null);
  const [addr, setAddr] = useState("");
  const [touched, setTouched] = useState(false);
  // PAPER IS THE DEFAULT NOW (the approved redesign is a light design). A visitor who
  // has chosen a theme keeps it: the stored key is unchanged, so only people who never
  // toggled see the new default.
  const [view, setView] = useState<View>("claim");
  const [tx, setTx] = useState<Tx | null>(null);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  // THE KEY THAT COMES WITH A GENERATED ADDRESS (risk register II, R-31). /api/account
  // answers with the address AND its spending key and says "copy the key now, it isn't
  // stored". The 2026-07-27 redesign kept the button and dropped the key, so for seven
  // weeks every "Generate a test address" drip went to an address nobody could ever
  // spend from: the coins gone, the address's 24 h cooldown spent, and nothing in the
  // ledger to tell it from a real drip. Held here until the person has copied it, and
  // the request button waits for that: a drip to an address whose key is on nobody's
  // clipboard is a drip to nobody. Never cleared on an edit: the panel and both gates
  // are keyed on the address, so an edit hides them and un-gates the pasted address
  // (theirs), and returning to the generated string brings them back. The first cut
  // nulled this on any edit, and review typed one character and deleted it: the exact
  // address, no panel, a normal Request button, paid with the key nowhere.
  const [genKey, setGenKey] = useState<{ address: string; secret: string; label: string; warning: string } | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyShown, setKeyShown] = useState(false);
  const [cooldownEnd, setCooldownEnd] = useState(0);
  // What the 429 actually said. `kind` decides which of two screens renders, because an
  // address that was just paid and a connection that is out of drips are different
  // situations with different advice - and "try a different address" is WRONG advice
  // for the second one, which is what the reported user was told.
  const [refusal, setRefusal] = useState<{ kind: "address" | "connection" | "subnet"; reason: string; nextAt: number | null; receipt: Receipt | null } | null>(null);
  // 0 rather than Date.now(): calling it during render gives the SERVER's clock on
  // the first paint and the client's on hydration, which is a mismatch, and it makes
  // render impure. The effect below sets the real value on mount and every second,
  // and until it does `remain` is max(0, 0 - 0) = 0, which is the correct first paint.
  const [now, setNow] = useState(0);
  const [errMsg, setErrMsg] = useState("");
  // WHICH failure, from the reply's status and fields (risk register II, R-34). One red
  // card, "Send failed, nothing left the wallet / Try again", used to wear every
  // non-empty 503, the 504 and the 4xx: the daily cap, the 75 s freshness hold, a full
  // queue, a bad address, and the 504 whose own sentence says do not retry. For the 504
  // the kicker was false and Try again re-solved a proof into a 429 with no receipt.
  //   failed   502: the sentence is true, Try again is right
  //   pow      403: the human check did not verify; nothing was claimed; try again
  //   offline  the POST never got an answer
  //   held     503 with a retryAfter (freshness, wallet lag, cTAZ recency): our side,
  //            not theirs, a countdown, and the button waits for it
  //   busy     503 kind busy: the queue is full; nothing was asked of the wallet
  //   cap      503 kind cap: today's budget; no Try again, the time it resets if known
  //   unknown  504: submitted, outcome unknown; no Try again, the address to watch
  //   bad      400: the request itself; back to the form with the address kept
  type FailKind = "failed" | "pow" | "offline" | "held" | "busy" | "cap" | "unknown" | "bad";
  // requestId: every API error carries one (src/lib/api.ts) and the card dropped it, so
  // a visitor writing to the contact on /terms had nothing to point at (R-39).
  const [fail, setFail] = useState<{ kind: FailKind; retryAt?: number | null; address?: string; requestId?: string }>({ kind: "failed" });
  // A held claim we stopped holding (the 15-minute give-up behind a fault). Shown on
  // the fault card, NOT as an error phase: the phase effect re-derives the phase from
  // status whenever queuedAddr changes, and it ran in the same commit as the give-up's
  // setPhase("error"), so the old give-up dropped the claim and its message together
  // (review of #522). Cleared the moment the visitor holds a claim again, cancels
  // one, starts over, or the fault ends: a sentence about a hold nobody made must not
  // outlive the hold it was about (round 3).
  const [holdDropped, setHoldDropped] = useState(false);
  const [lookupAddr, setLookupAddr] = useState("");
  const [lookupRes, setLookupRes] = useState("");
  const [elapsed, setElapsed] = useState(0);
  // difficulty is null from the moment the solve starts until the challenge arrives, so
  // the card (and its Cancel) is on screen for the whole solve, fetch included.
  const [powState, setPowState] = useState<{ hashes: number; difficulty: number | null; ms: number } | null>(null);
  // Set while a solve is running; calling it abandons the solve and the claim (R-38).
  const powCancel = useRef<(() => void) | null>(null);
  const [genErr, setGenErr] = useState("");
  const [txSeen, setTxSeen] = useState<{ known: boolean | null; confirmations: number | null } | null>(null);
  // A claim held while the node syncs. Persisted so a reload (or coming back
  // tomorrow) keeps the place in line; fires on its own when the node is ready.
  const [queuedAddr, setQueuedAddr] = useState<string | null>(null);
  // When the hold started, for the freshness deadline below.
  const [queuedAt, setQueuedAt] = useState<number | null>(null);

  const inFlow = useRef(false); // in a claim flow → don't let polling override the phase
  const submitStart = useRef(0);
  const sending = useRef(false);
  const powWorker = useRef<Worker | null>(null);
  const firing = useRef(false); // a queued claim mid-fire, don't fire twice

  // Which chain the claim goes to. Not persisted to localStorage on purpose: the held
  // claim is, and restoring a network someone picked yesterday would fire that hold at
  // a feature net they have since forgotten choosing.
  const [network, setNetwork] = useState<FaucetNetwork>("taz");
  const ctaz = status?.ctaz?.enabled ? status.ctaz : null;
  // The toggle only exists when there is something to toggle to. One tab is not a
  // choice, and rendering it as one implies a second network that is not there.
  const showToggle = !!ctaz;

  const drip = status?.dripTaz ?? 0.1;
  const dripText =
    network === "ctaz" && ctaz
      ? formatAmount(BigInt(ctaz.dripZat), "ctaz")
      : (drip % 1 === 0 ? drip.toFixed(0) : String(drip)) + " TAZ";

  // A stale pick must not survive the flag being turned off. If the deploy stops
  // offering cTAZ while a tab is open, the poll takes the toggle away, and without
  // this the page would keep the hidden selection and post it to an endpoint that now
  // answers 503. Snapping back to TAZ is the only state the page can still serve.
  useEffect(() => {
    if (network === "ctaz" && status && !status.ctaz?.enabled) setNetwork("taz");
  }, [status, network]);

  const basePhase = useCallback((s: Status | null, net: FaucetNetwork = "taz"): Phase => {
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
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/status").then((r) => r.json()).then((s) => { if (alive) setStatus(s); }).catch(() => {});
    load();
    const iv = setInterval(load, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  useEffect(() => {
    if (inFlow.current) return;
    const base = basePhase(status, network);
    if (base !== "fault") setHoldDropped(false);
    // A held claim shows as "queued" while the node syncs; anything else
    // (ready, empty) falls through so the fire effect below can take over.
    setPhase(queuedAddr && holding(base) ? "queued" : base);
  }, [status, basePhase, queuedAddr, network]);

  // Restore a held claim from a previous visit. The stored shape gained a timestamp
  // for the freshness deadline, so a bare string is a hold from before that and
  // starts its clock now: the alternative is treating an unknown age as expired,
  // which would drop a claim someone left overnight on the strength of a guess.
  useEffect(() => {
    const saved = localStorage.getItem("zfaucet_queued");
    if (!saved) return;
    let addrIn = saved;
    let atIn = Date.now();
    if (saved.startsWith("{")) {
      try {
        const parsed = JSON.parse(saved) as { a?: string; at?: number };
        if (!parsed.a) return;
        addrIn = parsed.a;
        if (typeof parsed.at === "number") atIn = parsed.at;
      } catch {
        return; // unreadable, treat as no hold rather than guess at it
      }
    }
    if (check(addrIn).ok) { setQueuedAddr(addrIn); setQueuedAt(atIn); }
  }, []);
  useEffect(() => {
    if (queuedAddr) localStorage.setItem("zfaucet_queued", JSON.stringify({ a: queuedAddr, at: queuedAt ?? Date.now() }));
    else localStorage.removeItem("zfaucet_queued");
  }, [queuedAddr, queuedAt]);

  // Give up on a hold behind a fault, and say so.
  //
  // A hold through a plain sync (node not ready, not frozen) stays indefinite, which
  // is existing and deliberate ("come back later, your place survives a reload"): a
  // sync finishes on a schedule we can see. A fault has no schedule. This was scoped
  // to the freshness gate alone; a hold behind a frozen node or a silent wallet ran
  // with no end, under a card that said "ready shortly". Nothing was ever claimed, so
  // there is no cooldown to release.
  useEffect(() => {
    if (!queuedAddr || queuedAt == null) return;
    // Any fault, not only the freshness gate: a hold through a frozen node or an
    // unreadable wallet was indefinite, and "ready shortly" for the duration.
    if (!status || basePhase(status, network) !== "fault") return;
    if (now - queuedAt < HOLD_MAX_MS) return;
    setQueuedAddr(null);
    setQueuedAt(null);
    setHoldDropped(true);
  }, [now, queuedAddr, queuedAt, status, basePhase, network]);

  // The moment the node is ready, a held claim fires through the normal
  // submit path (pow solved fresh here, a solution from queue time would
  // have expired). Once-guarded: polling keeps re-running this effect.
  useEffect(() => {
    if (!queuedAddr || firing.current) return;
    if (basePhase(status, network) !== "ready") return;
    firing.current = true;
    const target = queuedAddr;
    setQueuedAddr(null);
    setAddr(target);
    void submit(target).finally(() => {
      firing.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, queuedAddr, basePhase, network]);
  useEffect(() => {
    setNow(Date.now()); // immediately, so the first tick is not up to a second late
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    if (phase !== "submitting") return;
    const iv = setInterval(() => setElapsed(Date.now() - submitStart.current), 120);
    return () => clearInterval(iv);
  }, [phase]);
  // Ask OUR node whether the drip landed. A public explorer renders a page for
  // any hash, so it cannot answer this (#71).
  //
  // Stops once the drip is buried: a confirmed transaction does not become less
  // confirmed, and every poll spends a wallet RPC and a slice of the /api/tx
  // budget (#101). It deliberately keeps polling on "not seen" and on "cannot
  // say", because both of those can still change.
  useEffect(() => {
    // Bound to a local, not read off `tx` inside the closure. Now that txid is
    // optional the guard above does not narrow through the callback, and tsc said so:
    // without this the poll would build `/api/tx?txid=undefined` the moment the guard
    // and the read disagreed. cTAZ makes that reachable rather than theoretical.
    const txid = tx?.txid;
    if (!txid) { setTxSeen(null); return; }
    let alive = true;
    let iv: ReturnType<typeof setInterval> | undefined;
    const stop = () => { clearInterval(iv); iv = undefined; };
    const check = () =>
      fetch("/api/tx?txid=" + encodeURIComponent(txid))
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          const seen = { known: d.known ?? null, confirmations: d.confirmations ?? null };
          setTxSeen(seen);
          if ((seen.confirmations ?? 0) >= CONFIRMATIONS_ENOUGH) stop();
        })
        .catch(() => {});
    check();
    iv = setInterval(check, TX_POLL_MS);
    return () => { alive = false; stop(); };
  }, [tx?.txid]);

  useEffect(() => () => { powWorker.current?.terminate(); powWorker.current = null; }, []);
  // THE THEME LIVES IN THE SHELL NOW, and this page kept a second copy of it: a state nothing
  // rendered from, plus an effect still writing `zfaucet_theme` and `data-theme` on every
  // change. Two writers to one key with no coordination, where the only reason they agreed is
  // that both happened to start at "paper". The Shell owns the toggle, the storage and the
  // document attribute for all four pages; a page that renders <Shell> does not get a vote.

  // Solve the server's proof-of-work challenge in a worker so the tab never
  // freezes. Resolves with the solution to hand back with the claim. Rejects with
  // POW_CANCELLED when the visitor gives up: a solve that cannot be abandoned is a
  // tab a phone user closes (R-38), and the challenge is single-use so nothing is lost.
  const solvePow = () =>
    new Promise<PowSolution>((resolve, reject) => {
      let cancelled = false;
      setPowState({ hashes: 0, difficulty: null, ms: 0 });
      powCancel.current = () => {
        cancelled = true;
        powWorker.current?.terminate(); powWorker.current = null;
        powCancel.current = null;
        reject(POW_CANCELLED);
      };
      fetch("/api/pow/challenge")
        .then((r) => r.json())
        .then((ch) => {
          if (cancelled) return;
          if (!ch?.ok) { powCancel.current = null; reject(new Error(ch?.error || "no challenge")); return; }
          setPowState({ hashes: 0, difficulty: ch.difficulty, ms: 0 });
          const worker = new Worker("/pow-worker.js");
          powWorker.current = worker;
          worker.onmessage = (e: MessageEvent) => {
            const m = e.data;
            if (m.type === "progress") setPowState((s) => (s ? { ...s, hashes: m.hashes, ms: m.ms } : s));
            else if (m.type === "found") {
              worker.terminate(); powWorker.current = null; powCancel.current = null;
              resolve({ seed: ch.seed, difficulty: ch.difficulty, exp: ch.exp, sig: ch.sig, nonce: m.nonce });
            }
          };
          worker.onerror = () => { worker.terminate(); powWorker.current = null; powCancel.current = null; reject(new Error("worker error")); };
          worker.postMessage({ seed: ch.seed, difficulty: ch.difficulty });
        })
        .catch((err) => { if (!cancelled) { powCancel.current = null; reject(err); } });
    });

  // The key gate, in submit() and not only on the button: Enter in the address field
  // calls submit() directly, and a disabled button is no gate against a keyboard. Keyed
  // on the address so a pasted address is never held; a generated one is held until
  // its key has been copied or at least revealed.
  const keyUnseen = (address: string) => !!genKey && genKey.address === address && !keyCopied && !keyShown;
  const submit = async (target?: string) => {
    const address = (target ?? addr).trim();
    const c = check(address);
    if (!c.ok) { setTouched(true); return; }
    if (!target && keyUnseen(address)) return;
    // Held phases are held for the keyboard and for the error card's "Try again" too:
    // the button is disabled, but Enter in the address field and Try again land here
    // directly. Judged from the LIVE status, not from `phase`: the visitor whose failed
    // send tipped the verdict is sitting on the 502 card, phase "error", and their Try
    // again must land on the degraded card rather than solve a proof into the wallet.
    // A 503 rendered as "Send failed" under a card that says "not taking claims" would
    // be two stories on one screen, so this also leaves the flow.
    if (!target && basePhase(status, network) === "degraded") { inFlow.current = false; setPhase("degraded"); return; }
    if (!target && phase === "empty") return;
    if (sending.current) return;
    // Node still syncing: hold the claim instead of turning the user away.
    // It fires on its own the moment the node is ready (the effect above).
    // `target` set means we ARE the fire, never re-queue.
    if (!target && holding(basePhase(status, network))) {
      setHoldDropped(false);
      setQueuedAddr(address);
      setQueuedAt(Date.now());
      setPhase("queued");
      return;
    }
    sending.current = true;
    inFlow.current = true;
    setElapsed(0); setErrMsg(""); setTouched(false); setHoldDropped(false);
    setPhase("submitting");

    // Anti-abuse gate: solve the browser proof-of-work before we ask for coins.
    let pow: PowSolution | undefined;
    if (status?.challenge === "pow") {
      try {
        pow = await solvePow();
      } catch (err) {
        setPowState(null);
        if (err === POW_CANCELLED) {
          // Their choice, not a failure: back to the form with the address still in it.
          sending.current = false; inFlow.current = false;
          setPhase(basePhase(status, network));
          return;
        }
        setFail({ kind: "pow" });
        setErrMsg("Couldn't finish the human check. Refresh the page and try again.");
        setPhase("error");
        sending.current = false;
        return;
      }
      setPowState(null);
    }

    submitStart.current = Date.now();
    setElapsed(0);
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, network, ...(pow ? { pow } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        const d = detect(address);
        setTx({
          // Copied straight through, INCLUDING its absence. The receipt decides what to
          // say about a missing id by finding it missing, so a `?? ""` here would put a
          // blank txid row on screen instead of the explanation.
          txid: data.txid,
          to: address,
          priv: "priv" in d ? !!d.priv : true,
          explorerUrl: data.explorerUrl,
          at: Date.now(),
          // What the server says it did, not what we asked it to do. They agree today
          // and reading the reply costs nothing, and it is the reply that is true.
          network: data.network === "ctaz" ? "ctaz" : "taz",
          // The amount the NETWORK paid when it reports one (cTAZ's is fixed and ignores
          // the request), falling back to what we asked for.
          amountText: data.paidZat ? formatAmount(BigInt(data.paidZat), data.network === "ctaz" ? "ctaz" : "taz") : dripText,
        });
        rememberReceipt(
          data.network === "ctaz" ? "ctaz" : "taz",
          address,
          {
            txid: data.txid,
            explorerUrl: data.explorerUrl,
            at: Date.now(),
            network: data.network === "ctaz" ? "ctaz" : "taz",
            amountText: data.paidZat ? formatAmount(BigInt(data.paidZat), data.network === "ctaz" ? "ctaz" : "taz") : dripText,
          },
          (status?.cooldownSeconds ?? 86400) * 1000,
        );
        setPhase("success");
      } else if (res.status === 429) {
        // The server's clock time when it gives one, its duration otherwise. Both mean
        // the same instant; the ISO form is the one a person can read.
        const nextAtMs = data.nextAt ? Date.parse(data.nextAt) : NaN;
        setCooldownEnd(Number.isFinite(nextAtMs) ? nextAtMs : Date.now() + (data.retryAfterSeconds ?? status?.cooldownSeconds ?? 86400) * 1000);
        // Which limit refused, from the FIELDS the API sends, not from its sentence. A
        // first cut matched /connection/ over the reason and worked on the subnet refusal
        // only because that sentence happens to end "from a different connection" - a
        // rewording away from offering "Try a different address" to someone whose whole
        // network is over quota. Unknown shapes fall to "address", the card with the
        // least specific advice.
        const reason: string = typeof data.error === "string" ? data.error : "";
        const kind: "address" | "connection" | "subnet" =
          data.kind === "subnet" ? "subnet" : data.scope === "connection" ? "connection" : "address";
        // Only an ADDRESS refusal can be about a payment this browser made to this
        // address in this asset. A connection or subnet refusal may be someone else's
        // drip on the same router, and showing them a receipt from this tab would be
        // claiming a payment that was not theirs.
        const ttl = (status?.cooldownSeconds ?? 86400) * 1000;
        const receipt = kind === "address" ? (readReceipts(ttl)[receiptKey(network, address)] ?? null) : null;
        setRefusal({ kind, reason, nextAt: Number.isFinite(nextAtMs) ? nextAtMs : null, receipt });
        setPhase("cooldown");
      } else if (res.status === 503 && /empty/i.test(data.error || "")) {
        inFlow.current = false;
        setPhase("empty");
      } else if (res.status === 503 && data.kind === "sends") {
        // The wallet was judged between this page's last poll and the POST: the reply
        // is the verdict, so the page shows it rather than a red card that says the
        // send failed (it was never attempted) under a badge that says LIVE.
        inFlow.current = false;
        setPhase("degraded");
      } else {
        // The rest of the refusals, sorted by what is true about them, not by colour.
        const retry = typeof data.retryAfterSeconds === "number" && data.retryAfterSeconds > 0 ? data.retryAfterSeconds : null;
        const nextAtMs = data.nextAt ? Date.parse(data.nextAt) : NaN;
        const retryAt = Number.isFinite(nextAtMs) ? nextAtMs : retry != null ? Date.now() + retry * 1000 : null;
        const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
        if (res.status === 504) setFail({ kind: "unknown", address, requestId });
        else if (res.status === 503 && data.kind === "cap") setFail({ kind: "cap", retryAt, requestId });
        else if (res.status === 503 && data.kind === "busy") setFail({ kind: "busy", requestId });
        else if (res.status === 503 && retryAt != null) setFail({ kind: "held", retryAt, requestId });
        else if (res.status === 403) setFail({ kind: "pow", requestId });
        else if (res.status === 400) setFail({ kind: "bad", requestId });
        else setFail({ kind: "failed", requestId });
        setErrMsg(data.error || "The send didn't go through. Nothing left the wallet.");
        setPhase("error");
      }
    } catch {
      setFail({ kind: "offline" });
      setErrMsg("Couldn't reach the faucet. Check your connection and try again.");
      setPhase("error");
    } finally {
      sending.current = false;
    }
  };

  const again = () => {
    inFlow.current = false;
    setAddr(""); setTouched(false); setTx(null); setCopied(null); setErrMsg(""); setRefusal(null); setFail({ kind: "failed" });
    setQueuedAddr(null); setHoldDropped(false);
    setGenKey(null); setKeyCopied(false); setKeyShown(false);
    setPhase(basePhase(status, network));
  };

  // Clipboard is unavailable on http origins and in some in-app browsers, so
  // fall back to a hidden textarea rather than silently doing nothing.
  const copy = async (what: CopyTarget, text: string) => {
    // The async clipboard is absent on http origins and DENIED in some in-app and
    // headless browsers (it exists, then throws). Both fall back to the textarea, so a
    // blocked clipboard is a copy that still happens rather than a gate that never opens.
    const viaTextarea = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const done = document.execCommand("copy");
      ta.remove();
      return done;
    };
    try {
      let done = false;
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); done = true; } catch { done = viaTextarea(); }
      } else done = viaTextarea();
      if (!done) { setCopied(null); return false; }
      setCopied(what);
      setTimeout(() => setCopied(null), 1700);
      return true;
    } catch {
      setCopied(null);
      return false;
    }
  };

  /**
   * Plain-text receipt, the thing people actually paste into an issue or chat.
   *
   * The txid line SAYS there is none rather than being dropped. A missing line reads as
   * a truncated paste, and someone chasing a drip that never arrived would spend their
   * time wondering whether the receipt was complete instead of reading the answer.
   */
  const receiptText = (t: Tx) =>
    [
      `Zcash ${networkFacts(t.network).chain} faucet drip`,
      `amount:  ${t.amountText}`,
      `to:      ${t.to}`,
      t.txid ? `txid:    ${t.txid}` : `txid:    none (this network's faucet returns no transaction id)`,
      `privacy: ${t.priv ? "shielded (z to z)" : "transparent (public on-chain)"}`,
      `sent:    ${new Date(t.at).toISOString()}`,
      t.explorerUrl ? `explorer: ${t.explorerUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");

  // /api/account answers { ok, account: { address, … } }. Reading d.address
  // instead of d.account.address is what put a fake address in the box and
  // 400'd the most obvious try-it-now flow. There is no sample fallback any
  // more: a synthesized string cannot pass checksum validation, so handing one
  // out only moves the failure somewhere more confusing.
  const generate = async () => {
    setGenErr("");
    try {
      const r = await fetch("/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "shielded" }) });
      const d = await r.json();
      const generated = d?.account?.address;
      const secret = d?.account?.secret;
      if (d?.ok && typeof generated === "string" && check(generated).ok && typeof secret === "string" && secret) {
        setAddr(generated);
        setTouched(false);
        setGenKey({
          address: generated,
          secret,
          label: typeof d.account.secretLabel === "string" ? d.account.secretLabel : "Spending key (testnet)",
          warning: typeof d.account.warning === "string" ? d.account.warning : "Copy the key now, it isn't stored.",
        });
        setKeyCopied(false);
        setKeyShown(false);
        return;
      }
      setGenErr(d?.error ?? "Couldn't generate an address just now. Paste one from your wallet, or try again.");
    } catch {
      setGenErr("Couldn't reach the faucet to generate an address. Try again in a moment.");
    }
  };
  const doLookup = async () => {
    const a = lookupAddr.trim();
    if (detect(a).kind !== "ok") { setLookupRes("Not a testnet address, nothing to look up."); return; }
    setLookupRes("Looking up…");
    try {
      // POST, so the address is not in a URL that a proxy log or a browser history
      // keeps (R-36); the ledger will not store it in the clear either.
      const r = await fetch("/api/balance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: a }) });
      const d = await r.json();
      if (d?.ok === false) setLookupRes(d.error || "Couldn't look that up.");
      else if (d?.shielded && d?.queryable === false) setLookupRes(d.note || "Shielded balances are private. Provide a viewing key in a wallet to see this.");
      else if (typeof d?.balanceTaz === "number") setLookupRes(d.balanceTaz + " TAZ" + (d.kind ? " · " + d.kind : ""));
      else setLookupRes("No balance found for this address.");
    } catch { setLookupRes("Couldn't reach the backend."); }
  };

  /* derived */
  // "queued" is still a syncing node, just with a claim held. The badge and the
  // dot must keep saying so, or the header claims a readiness we do not have.
  // "checking" is not live. Leaving it out here made the badge read LIVE before the
  // first status arrived, a louder lie than the "syncing" it replaced.
  const live = !holding(phase) && phase !== "queued" && phase !== "degraded";
  const node = status?.node;
  const syncPct = node?.syncPercent ?? null;
  // Never rounds up to 100 while the node is unready: 99.994 printed as "100%" beside
  // a "Syncing" headline during the 2026-08-03 incident, which reads as a stuck page.
  // What the queued card is waiting on. A claim queued behind a fault is waiting for
  // the faucet, not for a sync, and "syncing… / the moment the node is ready" over a
  // frozen node is the R-33 story again with a different kicker.
  const queuedBehindFault = !!status && faultReason(status) !== null;
  // The two stat strips. A frozen node is not "syncing (99.99%)": that number is our
  // tip over an external tip that the node stopped following, and it was the strip's
  // reading for the whole of 2026-09-07. Frozen says frozen, and the sync cell says how
  // far behind rather than how close.
  const height = node?.height ?? null;
  const reserve = status?.reserve;
  const donation = status?.donationAddress?.trim() ?? "";
  // A refill running while we can still serve must read as healthy, not as an
  // outage. It only changes the copy when the balance is genuinely too low.
  const refilling = !!reserve?.refilling;
  const refillPct =
    reserve && reserve.spendableTaz != null && reserve.targetTaz > 0
      ? Math.min(100, Math.round((reserve.spendableTaz / reserve.targetTaz) * 100))
      : null;
  // Something is actually putting coins in: the miner is running and the shielding
  // step is not failing. Only then may the card promise that drips resume.
  const refillHealthy = !!status?.miner?.active && !!reserve?.shieldCoinbase && !(status && harvestFailing(status));

  // THE CARD ANIMATES ITS OWN HEIGHT AND NOTHING OUTSIDE IT MOVES (owner ruling, 18:56Z),
  // animated the way the frozen preview animates it: 460ms, cubic-bezier(.16,1,.3,1), the box
  // and nothing inside it.
  //
  // ONLY ON A PHASE CHANGE, AND THE `from` IS THE PAINTED HEIGHT. The first version ran on every
  // render and cancelled whatever was in flight, so any render inside the 460ms snapped the rest
  // of the travel: into success 463 -> 602 was cancelled at 9ms, a 139px single-frame step. The
  // status phases only looked right because the local doubles answer in under a millisecond; at
  // production's 790ms TTFB every status transition would have been cancelled at about 210ms,
  // and since a status change is TWO renders the first animation died before its first frame.
  // Found by the CTO's red-team on #583.
  //
  // `cardFrom` is filled in the CLEANUP, which React runs BEFORE the DOM mutation of the next
  // commit. That is the React equivalent of the preview reading `wasH` before it swaps the
  // panel, and it is what makes cancelling unnecessary: the height we animate FROM is the height
  // the card is actually painted at, interpolation included, so a change arriving mid-flight
  // continues from where the card visibly is instead of jumping back.
  //
  // Reduced motion is read in JS and that is load-bearing: globals.css:264 and
  // redesign-shell.css:142 both kill `animation` and `transition` under prefers-reduced-motion,
  // and a Web Animations API animation is NEITHER, so left to the stylesheet it would play at
  // full size for exactly the people who asked it not to.
  const cardPhaseKey = [
    phase, fail.kind, refusal?.kind ?? "", network,
    refilling ? "r" : "", refillHealthy ? "h" : "", powState ? "p" : "", tx ? "t" : "",
  ].join("|");
  // FROM IS THE PAINTED HEIGHT AT THE MOMENT OF THE CHANGE. TO IS THE NATURAL HEIGHT.
  // Round two got the second one wrong and the sweep could not see it.
  //
  // TO: measuring `getBoundingClientRect()` while OUR animation is still running returns the
  // INTERPOLATED value, not the height the new phase wants. `|to - from|` then comes out under a
  // pixel, the effect returns early, and the real change lands in a single frame when the old
  // animation ends - into success 411 -> 602 in ONE frame at 1440, 215px. The sweep called that
  // "the content settled afterwards"; it was not, the content was in the DOM from the first
  // frame and the target was stale. So our own animation is cancelled BEFORE `to` is measured.
  //
  // FROM: while that animation is running the box IS the interpolated value, so measuring
  // BEFORE the cancel gives exactly what is on screen - which is the preview's `wasH`, and it is
  // what lets a change arriving mid-flight continue from where the card visibly is. With nothing
  // running the painted height is the one the recorder stored at the end of the last commit,
  // which is current precisely because without an animation the height only moves on a render.
  //
  // The Animation object is held in a ref rather than found through `getAnimations()`: it needs
  // no second feature check, and the cancel reaches our animation and nothing else - the mascot
  // and the entrance animations share this document.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    // Checked before anything else on the element: a browser with `animate` and no
    // `getAnimations` used to reach a crash here instead of the plain swap.
    if (typeof el.animate !== "function") return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const running = cardAnim.current;
    const painted = el.getBoundingClientRect().height;
    const from = running && running.playState === "running" ? painted : cardFrom.current;
    if (running) { running.cancel(); cardAnim.current = null; }
    if (from == null) return;                       // first paint has nothing to animate from
    const to = el.getBoundingClientRect().height;   // natural: ours is cancelled
    // A change under a pixel is not a phase change, it is a countdown digit changing width.
    if (Math.abs(to - from) < 1) return;
    const previous = el.style.overflow;
    el.style.overflow = "hidden";
    const run = el.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: 460, easing: "cubic-bezier(.16,1,.3,1)" },
    );
    run.id = CARD_HEIGHT_ANIM;
    cardAnim.current = run;
    const restore = () => { el.style.overflow = previous; if (cardAnim.current === run) cardAnim.current = null; };
    run.onfinish = restore;
    run.oncancel = restore;
  }, [cardPhaseKey]);
  // THE RECORDER, and it must stay BELOW the animator. No dependency array on purpose: it runs
  // after every commit, so what it stores is always the height as of the last paint.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (el) cardFrom.current = el.getBoundingClientRect().height;
  });
  const c = check(addr);
  const badgeShow = c.ok || ("label" in c && !!c.label);
  const remain = Math.max(0, cooldownEnd - now);

  // Reads no ref. `sending.current` is set false SYNCHRONOUSLY in submit's finally
  // while setPhase("success") only schedules a re-render, so a render landing in that
  // window saw phase "submitting" with the ref already false and let the bar reach
  // 100% under a UI still saying submitting. Capping on the phase alone is both the
  // intent and reactive.
  const proofFrac = phase === "submitting" ? Math.min(0.95, elapsed / (PROOF_SECONDS * 1000)) : 0;
  const powEstimate = powState && powState.difficulty != null ? powEstimateSeconds({ ...powState, difficulty: powState.difficulty }) : null;
  const steps: [string, number][] = [
    ["Checking eligibility", 0.09],
    ["Selecting shielded notes", 0.13],
    ["Building the zero-knowledge proof", 0.63],
    ["Broadcasting to the testnet", 0.15],
  ];
  let acc = 0, curStep = 0;
  const proofSteps = steps.map(([label, w], i) => {
    const from = acc; acc += w;
    const done = proofFrac >= acc, active = !done && proofFrac >= from;
    if (active) curStep = i;
    return { label, mark: done ? "done ✓" : active ? "···" : "", color: done || active ? "var(--color-text)" : muted(40) };
  });
  if (proofFrac >= 1) curStep = steps.length - 1;

  // Honest badge: "TOPPING UP" only when a refill is actually running, "EMPTY"
  // when it isn't. A refill with the balance still serviceable stays "LIVE".
  // Queued is a syncing node with a claim held, so it reads PREPARING too.
  const statusText =
    phase === "checking"
      ? "CHECKING"
      : phase === "fault" || (phase === "queued" && queuedBehindFault)
        ? "NOT READY"
      : phase === "syncing" || phase === "queued"
      ? "PREPARING"
      : phase === "empty"
        ? (refilling ? "TOPPING UP" : "EMPTY")
        : phase === "degraded"
          ? "DEGRADED"
          : "LIVE";
  // Colour carries the state, and red now means what red means. Redundant with
  // the badge text and the status region, never the only signal.
  const dot =
    phase === "empty"
      ? refilling
        ? { fill: "var(--color-accent)", ring: "var(--color-accent)" } // topping up, calm
        : { fill: "var(--color-empty)", ring: "var(--color-empty)" } // genuinely empty
      : phase === "degraded" || phase === "fault" || (phase === "queued" && queuedBehindFault)
        ? { fill: "var(--color-empty)", ring: "var(--color-empty)" } // a fault, and red means what red means
      : live
        ? { fill: "var(--color-live)", ring: "var(--color-live)" }
        : { fill: "transparent", ring: muted(45) }; // syncing, no alarm

  // One persistent live region announces phase changes to screen readers. It
  // exists from first render (live regions mounted later announce unreliably)
  // and holds a stable sentence per state, so it never spams: no tick counters,
  // no percentages.
  const announce =
    phase === "checking" ? "Checking the faucet's status."
    : phase === "queued" ? `Your claim is queued. It sends on its own when the ${queuedBehindFault ? "faucet is back" : "node is ready"}.`
    : phase === "syncing" ? "Node is syncing. The faucet will be ready shortly."
    : phase === "fault" ? "The faucet is having a problem and is not taking claims right now. Nothing to do on your side."
    : phase === "empty" ? (refilling ? (refillHealthy ? "Topping up the reserve. Drips resume in a moment." : "The faucet's reserve is low.") : "The faucet is out of TAZ right now.")
    : phase === "degraded" ? "Sends are failing right now, so the faucet is not taking claims. Nothing to do on your side."
    : phase === "submitting" ? (powState ? "Checking you are human. It runs on its own; there is a Cancel button if you would rather not wait." : "Sending your testnet ZEC. Keep this tab open.")
    : phase === "success" ? "Sent. Your testnet ZEC is on its way."
    : phase === "cooldown" ? "Already claimed. A drip went out on this address or this connection in the last 24 hours."
    : phase === "error" ? (
        fail.kind === "held" ? "Not right now, on our side. " + errMsg
        : fail.kind === "busy" ? "The faucet is busy. Nothing left the wallet. " + errMsg
        : fail.kind === "cap" ? "The faucet has paid out its daily amount. " + errMsg
        : fail.kind === "unknown" ? "Your drip was submitted and its outcome is unknown. " + errMsg
        : fail.kind === "bad" ? "That request could not be taken. " + errMsg
        : fail.kind === "pow" ? "The human check did not pass. Nothing was claimed. " + errMsg
        : fail.kind === "offline" ? errMsg
        : "The send failed. Nothing left the wallet."
      )
    : "Faucet ready.";

  const kicker: CSSProperties = { fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--color-accent-text)" };
  const rowLine: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--color-divider)", fontFamily: "var(--mono)", fontSize: 11.5 };

  return (
    // `app` stays on the outer element: it is what the smoke's theme and contrast checks
    // find, and the redesign has no reason to rename it.
    // THE SHELL IS ONE COMPONENT NOW (src/components/Shell.tsx). S1 landed the stage,
    // masthead and footer inline here, which was right while this was the only page. S5
    // gives /terms, /donate and /fund the same chrome, and the snapshot's subpage header
    // is byte-identical to this one apart from the nav, so a second copy would be a header
    // that drifts. Moved rather than duplicated, and page.tsx moves onto it in the SAME
    // commit as the pages, so there is never a moment with two definitions.
    <Shell
      nav={{ kind: "views", view, onView: (v: string) => setView(v as typeof view), views: VIEWS }}
      badge={{ word: statusText, dot }}
      status={status}
      onStripClick={() => setView("analytics")}
    >
      <main className="views">
        {/* THE HERO (S2a). `legacy-measure` is gone from this view because the view is
            transcribed now: the design's hero is a three-column grid of its own and capping
            it at 760px would squeeze exactly what this slice landed. The other three views
            keep the cap until their slices land, held by ui-smoke's count and by
            src/app/legacyMeasure.test.ts, which keys this view to the `id="claim"` below. */}
        <section className="view hero" data-view="claim" data-testid="view-claim" aria-label="Claim" hidden={view !== "claim"}>
          <p className="sr-only" role="status">{announce}</p>
          <div className="hero-grid">
            <div className="hero-copy">
              <p className="eyebrow mono">Zcash testnet faucet</p>
              <h1 id="h1">Get free testnet ZEC</h1>
              <p className="lede"><b>{dripText}</b> per address, every 24 hours.</p>
              {/* THE PUZZLE IS EXPLAINED BEFORE THE BUTTON, which is R-38's property, and now
                  earlier than before: it used to sit under the claim button and it is the
                  hero's second line now. It MOVED rather than being duplicated - the
                  snapshot's hero carries this sentence and the card already had its own copy,
                  so transcribing the hero literally would have said it twice on one page.

                  STILL CONDITIONAL ON THE CHALLENGE BEING ON. The snapshot states it flat
                  because the design assumes proof of work, but a deployment running
                  FAUCET_CHALLENGE=none would then promise a puzzle that never runs. The
                  wording is the snapshot's, which is also the post-ruling wording - the
                  version it replaces used a prose colon, which the owner has banned. */}
              {status?.challenge === "pow" && (
                <p className="lede small">Your browser solves a short puzzle instead of a CAPTCHA. A few seconds, longer on a phone, and you can cancel it.</p>
              )}
            </div>
            <figure className="hero-mascot" aria-label="The faucet's fox, turning to follow your pointer">
              <Mascot />
              <figcaption className="mascot-cap">He knows you&apos;re here. He can&apos;t see the transaction. Nobody can.</figcaption>
            </figure>
            {/* THE CARD SHELL, with the CURRENT claim markup inside it. S2b transcribes the
                card's own contents and puts the phase changes on `motion`; this slice gives
                them the shell they will live in, so the hero is real a merge earlier. */}
            <article className="card claim feature" id="claim" aria-labelledby="h1" ref={cardRef}>

        {/* TAZ only. Every number in it (sync percent, our block height, our node
            height) is about OUR Zebra, and rendering it under a cTAZ hold would show
            someone a progress bar for a chain their claim has nothing to do with. The
            cTAZ equivalent is the readiness block above, which reads their node. */}
        {/* GETTING READY (index.html:449-454). The snapshot has ONE panel for our `checking`
            and `syncing`; the 23:08Z ruling splits them by content: syncing shows the sync
            percent because there is one, checking does not because there is nothing to show yet.
            TAZ only - every number here is about OUR Zebra, and a progress bar under a cTAZ hold
            is a bar for a chain the claim has nothing to do with. */}
        {(phase === "syncing" || phase === "checking") && network === "taz" && (
          <div className="phase" data-phase="getting-ready">
            <div className="kicker">Getting ready</div>
            <h3>{phase === "checking" ? "Checking the faucet's status" : "Syncing the node"}</h3>
            <p>
              {phase === "checking"
                ? "Reading the node and the wallet. This takes a moment."
                : "Our node is catching up with the network. Sends start when it is ready."}
            </p>
            {phase === "syncing" && (
              <>
                <div className="prog" role="progressbar" aria-label="Node sync progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={syncPct != null ? Math.min(syncPct, node?.ready === true ? 100 : 99.5) : undefined} style={{ ["--w" as string]: syncBarWidth(syncPct, node?.ready === true) }}>
                  <i />
                </div>
                <div className="figs">
                  <span><b className="num">{syncPct != null ? syncPct.toFixed(2) : "—"}</b>% synced</span>
                  <span><b className="mono">{height != null ? num(height) : "—"}</b>height</span>
                </div>
              </>
            )}
          </div>
        )}

        {/* NOT READY (index.html:455-458). The ruling: `fault` takes this panel, with the
            button below reading "Queue it, sends when the faucet is back". The hold-dropped
            line is ours and has no counterpart in the snapshot - it reports a claim we stopped
            holding, which the mock has no state for - so it is declared rather than dropped. */}
        {phase === "fault" && network === "taz" && (
          <div className="phase" data-phase="not-ready">
            <div className="kicker">Not ready</div>
            <h3>The faucet is having a problem</h3>
            <p>
              {status ? `${(faultReason(status) ?? "something is not right").replace(/^./, (c2) => c2.toUpperCase())}. ` : ""}
              Nothing to do on your side. You can queue the request, and it sends when the faucet is back.
            </p>
            {holdDropped && (
              <p data-testid="hold-dropped">
                We held your claim for {Math.round(HOLD_MAX_MS / 60_000)} minutes and the faucet did not recover, so we
                stopped holding it rather than keep you waiting. Nothing was claimed and your cooldown is untouched.
              </p>
            )}
          </div>
        )}

        {/* QUEUED (index.html:459-463). One panel, two data states: `queuedBehindFault` picks
            the sentence, which is what page.tsx already did for the live region. */}
        {phase === "queued" && queuedAddr && (
          <div className="phase" data-phase="queued">
            <div className="kicker">Queued</div>
            <h3>You&apos;re in line</h3>
            <p>
              {queuedBehindFault && status ? `The faucet is having a problem: ${faultReason(status)}. ` : ""}
              Your address is in the queue and sends when the {queuedBehindFault ? "faucet is back" : "node is ready"}.
              You can close this tab.
            </p>
            <div className="figs">
              <span><b className="num">{status?.queueDepth != null ? num(status.queueDepth) : "—"}</b>ahead of you</span>
            </div>
          </div>
        )}

        {/* RESERVE LOW (index.html:469-473): ready, and a refill is due. Claims still work,
            which is the whole point of the panel being separate from `empty`. */}
        {phase === "ready" && refilling && network === "taz" && (
          <div className="phase" data-phase="reserve-low">
            <div className="kicker">Reserve</div>
            <h3>The reserve is low</h3>
            <p>Claims still work. A refill is due, and if it runs out this page says so.</p>
            <div className="figs">
              <span><b className="num">{reserve?.spendableTaz != null ? num(Math.floor(reserve.spendableTaz)) : "—"}</b>spendable TAZ</span>
              <span><b className="num">{reserve?.lowTaz != null ? num(reserve.lowTaz) : "—"}</b>low mark</span>
            </div>
          </div>
        )}

        {/* TOPPING UP (index.html:464-468): empty AND refilling AND the refill looks healthy.
            The hatched bar is `.prog.hatch`, whose rule and keyframe are SDE-UI's; this renders
            the element and defines neither, so the cascade has one definition of each. */}
        {phase === "empty" && refilling && refillHealthy && network === "taz" && (
          <div className="phase" data-phase="topping-up">
            <div className="kicker">Topping up the reserve</div>
            <h3>Refilling from the main wallet</h3>
            <p>Claims resume when the reserve is back above the line.</p>
            <div
              className="prog hatch"
              role="progressbar"
              aria-label="Refill progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={refillPct ?? undefined}
              // The snapshot hard-codes `--w:60%`; ours is the real fraction of the target the
              // reserve currently holds, which is the number the bar is claiming to show.
              style={{ ["--w" as string]: `${refillPct ?? 0}%` }}
            >
              <i />
            </div>
          </div>
        )}

        {/* NOT TAKING CLAIMS (index.html:474-477). The reason sentence is `sends.reason`,
            read off the status and never asserted: this card once said "refilled by hand"
            beside a panel showing coinbase shielding on (R-39). */}
        {phase === "degraded" && (
          <div className="phase" data-phase="not-taking">
            <div className="kicker">Not taking claims</div>
            <h3>Sends are failing on our side right now</h3>
            <p>
              {status?.sends?.reason ? `${status.sends.reason.charAt(0).toUpperCase()}${status.sends.reason.slice(1)}. ` : ""}
              This is watched on our side and usually clears within minutes. No proof-of-work is asked for while it
              lasts; the button comes back when sends land again.
            </p>
          </div>
        )}

        {/* EMPTY (index.html:478-482). Widened from `!refilling` to "not topping up": a refill
            that is running but NOT healthy (miner off, or shielding not permitted) is not
            "topping up", and when `topping-up` took the healthy condition this state would
            otherwise have had no panel at all. */}
        {phase === "empty" && !(refilling && refillHealthy) && network === "taz" && (
          <div className="phase" data-phase="empty">
            <div className="kicker">Empty</div>
            <h3>The faucet is out of TAZ right now</h3>
            <p>If you have testnet ZEC to spare, a donation refills it for everyone.</p>
            {donation && (
              <div className="row">
                <code className="mono">{donation}</code>
                <button className="tag" type="button" onClick={() => void copy("donation", donation)}>
                  {copied === "donation" ? "Copied ✓" : "Copy address"}
                </button>
                <a className="tag" href="/donate">Why, and how it helps →</a>
              </div>
            )}
          </div>
        )}

        {/* THE TOGGLE. A tablist rather than two buttons, because that is what it is:
            picking one of a set changes the panel below it, and a screen reader user
            gets arrow-key movement and a spoken "2 of 2" for free. Only rendered when
            there is a second network, since one tab is not a choice.

            Brutalist like everything else: 2px borders, square corners, the selected
            tab inverted. The selection is carried by the border weight, the inversion
            AND aria-selected, never by colour alone. */}
        {showToggle && (phase === "ready" || phase === "checking" || phase === "syncing" || phase === "fault" || phase === "empty" || phase === "queued") && (
          <div>
            {/* THE SNAPSHOT'S TABS (index.html:415-418), with every behaviour the brutalist
                version had. The design carries the selection with a filled pill and
                `aria-selected`; the keyboard handling, the spelled-out accessible name and the
                roving tabIndex below are ours and are not in the snapshot, because the snapshot
                is a static mock and this is a real tablist. Transcribing a design does not mean
                transcribing away the things a screen reader needs. */}
            <div className="tabs" role="tablist" aria-label="Which network to claim on">
              {(["taz", "ctaz"] as const).map((n) => {
                const f = networkFacts(n);
                const on = network === n;
                return (
                  <button
                    key={n}
                    role="tab"
                    id={`net-tab-${n}`}
                    aria-selected={on}
                    aria-controls="net-panel"
                    // Spelled out, because the two spans below compute an accessible
                    // name of "cTAZfeature net, beta" with no separator: a flex gap is
                    // a visual space, not a textual one. Verified in a browser, which
                    // is the only place that difference shows up.
                    aria-label={f.beta ? `${f.tab}, ${f.beta}` : f.tab}
                    // Only the selected tab is in the tab order, per the tablist
                    // pattern: arrow keys move within the set, Tab leaves it.
                    tabIndex={on ? 0 : -1}
                    onClick={() => setNetwork(n)}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                      e.preventDefault();
                      const next: FaucetNetwork = n === "taz" ? "ctaz" : "taz";
                      setNetwork(next);
                      document.getElementById(`net-tab-${next}`)?.focus();
                    }}
                    // `data-parked` is the snapshot's own hook for the second tab's small
                    // word (`.tabs button[data-parked] small`), so the word is styled by the
                    // sheet rather than by an inline rule nobody can override.
                    data-parked={f.beta ? "" : undefined}
                  >
                    {f.tab}
                    {f.beta && <small>{f.beta}</small>}
                  </button>
                );
              })}
            </div>
            {/* Says what the selected network IS, under the tabs, because a four-letter
                ticker does not tell anyone what chain they are about to be paid on. */}
            <p id="net-panel" role="tabpanel" aria-labelledby={`net-tab-${network}`} style={{ margin: "9px 0 0", fontSize: 12.5, lineHeight: 1.5, color: muted(62) }}>
              {network === "ctaz"
                ? "Crosslink is a feature net running an unreleased consensus change. Coins here are for trying that out, they are not testnet TAZ, and the chain can be reset without notice."
                : "Public Zcash testnet. This is the one to use unless you know you want the other."}
            </p>
          </div>
        )}

        {/* The cTAZ node's own readiness, in the words the gate uses. Five states, and
            each says something different about what to do next. Shown only when it is
            NOT ready, because a green line telling someone a healthy thing is healthy
            is the sort of decoration that gets ignored when it changes. */}
        {network === "ctaz" && ctaz && !ctaz.servable && (
          <div style={{ border: "2px solid var(--color-divider)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={kicker}>{ctaz.readiness === "not-activated" ? "Not available" : "Not ready"}</span>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(70), maxWidth: "52ch" }}>
              {ctaz.readiness === "behind"
                ? "The Crosslink node is trailing the finality layer, so it is not current enough to pay out. It usually catches up within a couple of rounds."
                : ctaz.readiness === "stale"
                  ? "The Crosslink node last answered too long ago for us to act on, so we are not sending on its word. Nothing is wrong with your address."
                  : ctaz.readiness === "not-activated"
                    ? "This node does not have the finality layer switched on, so there is no cTAZ to hand out from it."
                    : "We cannot read the Crosslink node's status right now, so we will not claim it is ready. That is different from knowing it is broken."}
            </p>
          </div>
        )}

        {/* THE SNAPSHOT'S FIELD ROW (index.html:421-425): `.fieldwrap`, a `.label` carrying the
              address-kind badge on its right, the `.prompt` input, and one `.hint` line under it.
              The ids and testids are unchanged - `zaddr`, `address-input`, `addrmsg` - because
              assertions written months ago key on them and a transcription that renames its own
              hooks makes its suite green by deleting the subject. */}
        {(phase === "ready" || phase === "checking" || phase === "syncing" || phase === "fault" || phase === "empty" || phase === "degraded") && (
          <div className="fieldwrap">
            <label className="label" htmlFor="zaddr">
              <span>Your testnet address</span>
              {/* `.abadge` is the design's own element for the kind word, and it is NOT a status
                  chip: `.abadge` here, `.tag` in the hero, different owners. Empty `data-kind`
                  when there is nothing to say, which is what `.abadge:empty` in the sheet hides. */}
              <span className="abadge" data-kind={badgeShow && "label" in c ? (("priv" in c && c.priv === false) ? "public" : "shielded") : ""}>
                {badgeShow && "label" in c ? c.label : ""}
              </span>
            </label>
            <input id="zaddr" data-testid="address-input" className="prompt" type="text" spellCheck={false} autoComplete="off" autoCapitalize="off" placeholder="utest1… / ztestsapling… / tm…" value={addr} onChange={(e) => { setAddr(e.target.value); setTouched(false); }} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} aria-describedby="addrmsg" />
            <div id="addrmsg" className="hint" aria-live="polite">
              {"priv" in c && c.priv === false && <span style={{ fontSize: 12, lineHeight: 1.45, color: muted(62) }}>Transparent address, so this drip will be visible on-chain.</span>}
              {/* THE DESIGN'S BAD COLOUR, not the retired palette's. These two carried inline
                  `var(--color-accent-800)` - #7c1405 paper, #ffc4b8 ink - from the sheet the
                  redesign replaces, which an inline style carries past any stylesheet fix.
                  Found by the red-team's sweep for this shape (L20). */}
              {touched && "err" in c && c.err && <span style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--bad-text)", fontWeight: 500, maxWidth: "52ch" }}>{c.err}</span>}
              {genErr && <span style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--bad-text)", fontWeight: 500, maxWidth: "52ch" }}>{genErr}</span>}
              {!addr.trim() && <button className="linkbtn" type="button" onClick={generate}>Make a throwaway address and key</button>}
            </div>
            {genKey && genKey.address === addr.trim() && (
              <div data-testid="generated-key" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", border: "1px solid var(--color-divider)", borderRadius: 6 }}>
                <span style={{ ...kicker, color: muted(60) }}>{genKey.label}</span>
                <code data-testid="generated-key-secret" aria-label={keyShown ? undefined : "Spending key, hidden"} style={{ fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.5, wordBreak: "break-all", color: keyShown ? "inherit" : muted(55) }}>
                  {keyShown ? genKey.secret : "•".repeat(Math.min(genKey.secret.length, 48))}
                </code>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => void copy("key", genKey.secret).then((okCopy) => { if (okCopy) setKeyCopied(true); })}>{copied === "key" ? "Copied ✓" : keyCopied ? "Copy key again" : "Copy key"}</button>
                  <button className="btn btn-ghost btn-sm" aria-pressed={keyShown} onClick={() => setKeyShown((v) => !v)} style={{ padding: 0 }}>{keyShown ? "Hide" : "Reveal"}</button>
                </div>
                <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: muted(62), maxWidth: "52ch" }}>
                  {genKey.warning} {keyCopied ? "Keep it somewhere: it is the only way to spend what arrives." : keyShown ? "Copy it from the screen before you request: it is the only way to spend what arrives." : "The request button waits until you have copied or revealed it: a drip to an address whose key is nowhere is a drip to nobody."}
                </p>
                <p aria-live="polite" className="sr-only">{copied === "key" ? "Spending key copied." : ""}</p>
              </div>
            )}
            {/* THE SNAPSHOT'S PRIMARY ACTION (index.html:432). `.automate`, and the arrow comes
                from `.automate::after` rather than an inline span - which is not only tidier:
                `.automate:disabled::after{content:none}` takes the arrow away when the button is
                disabled, and our inline span drew it in every state including "Waiting for a
                refill". The design had thought about that and our markup had not. */}
            <button data-testid="claim-button" className="automate" data-accent type="button" onClick={() => void submit()} disabled={phase === "empty" || phase === "degraded" || (!!genKey && genKey.address === addr.trim() && !keyCopied && !keyShown)}>
              <span>{genKey && genKey.address === addr.trim() && !keyCopied && !keyShown ? "Copy the key first" : phase === "checking" ? "Checking status…" : phase === "syncing" ? "Queue it, sends when the node is ready" : phase === "fault" ? "Queue it, sends when the faucet is back" : phase === "empty" ? (refilling && refillHealthy ? "Topping up, back in a moment" : "Waiting for a refill") : phase === "degraded" ? "Not taking claims right now" : "Request " + dripText}</span>
            </button>
            <p style={{ margin: 0, fontSize: 11.5, letterSpacing: ".02em", color: muted(55), fontFamily: "var(--mono)" }}>{dripText} · once per address / 24h · shielded z→z</p>
            {/* The puzzle explanation moved UP to the hero's second line (S2a), so it is
                read before the button rather than under it and the page says it once. R-38's
                property is kept and strengthened; the copy is in the hero above. */}
          </div>
        )}

        {phase === "submitting" && powState && (
          <div style={{ border: "2px solid var(--color-text)", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 13 }}>
            <span style={kicker}>Human check, no CAPTCHA</span>
            <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.25 }}>Checking you&apos;re human…</h2>
            <div style={{ height: 10, border: "2px solid var(--color-text)", position: "relative", overflow: "hidden" }}>
              <i style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, background: "repeating-linear-gradient(135deg,var(--color-accent) 0 3px,transparent 3px 7px)", backgroundSize: "26px 26px", animation: "hatch .9s linear infinite" }} />
            </div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: muted(62) }}>
              Your browser is solving a small cryptographic puzzle so bots cannot drain the faucet. Nothing to click, nothing tracked.
              {/* An estimate in seconds, not bits and hashes (R-38): ~10 s on a phone at 20
                  bits and ~5 min at the 25-bit ceiling are facts a visitor can decide on. It is
                  a lottery, so "usually about", never a countdown. */}
              {" "}{powEstimate == null ? "Measuring how fast this device hashes…" : `Usually ${powEstimateText(powEstimate)} on this device; it is a lottery, so it can run longer.`}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: muted(50) }}>difficulty {powState.difficulty ?? "…"} bits · {powState.hashes.toLocaleString("en-US")} hashes · {Math.round(powState.ms / 1000)} s</span>
              <button className="btn btn-ghost btn-sm" onClick={() => powCancel.current?.()} style={{ padding: 0 }}>Cancel</button>
            </div>
          </div>
        )}

        {phase === "submitting" && !powState && (
          <div style={{ border: "2px solid var(--color-text)", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 13 }}>
            <span style={kicker}>Sending, keep this tab open</span>
            <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.25 }}>{steps[curStep][0]}…</h2>
            <div style={{ height: 10, border: "2px solid var(--color-text)", position: "relative", overflow: "hidden" }}>
              <i style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: Math.round(proofFrac * 100) + "%", background: "repeating-linear-gradient(135deg,var(--color-accent) 0 3px,transparent 3px 7px)", backgroundSize: "26px 26px", animation: "hatch .9s linear infinite" }} />
            </div>
            <div>
              {proofSteps.map((s, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: "1px solid var(--color-divider)", fontFamily: "var(--mono)", fontSize: 11.5, color: s.color }}>
                  <span>{s.label}</span><span>{s.mark}</span>
                </div>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: muted(62) }}>A shielded send builds a zero-knowledge proof before it can be broadcast. That is the wait. It is doing the privacy work.</p>
          </div>
        )}

        {phase === "success" && tx && (
          <div style={{ border: "2px solid var(--color-text)", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: 16, borderBottom: "2px solid var(--color-text)", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, background: "var(--color-surface)" }}>
              <span data-testid="sent-badge" style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase" }}>Sent ✓</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em", color: muted(55) }}>just now</span>
            </div>
            <div style={{ padding: "18px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                {/* What was PAID, from the response, not what the form offered. cTAZ's
                    amount is fixed by their node and ignores what we ask for, so the
                    two can differ and only one of them is true. */}
                <span style={{ fontSize: "clamp(30px,8vw,42px)", fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1 }}>{tx.amountText}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: muted(55) }}>on its way</span>
              </div>
              <div>
                {/* Full values in title + a copyable receipt below: the shortened
                    forms are for reading, never the only way to get the data. */}
                <div style={rowLine}><span style={{ color: muted(55) }}>to</span><span title={tx.to} style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>{short(tx.to, 12, 6)}</span></div>
                {/* The row is here either way, and it answers the question either way.
                    Hiding it on cTAZ would leave someone looking for a txid that the
                    receipt never mentions, which reads as an omission rather than as
                    the network's answer. `tx.txid` decides this, not `tx.network`: the
                    page reports what came back. */}
                <div style={rowLine}>
                  <span style={{ color: muted(55) }}>txid</span>
                  {tx.txid ? (
                    <span title={tx.txid} style={{ fontWeight: 700 }}>{short(tx.txid, 10, 8)}</span>
                  ) : (
                    <span style={{ fontWeight: 700, textAlign: "right", maxWidth: "66%" }}>none, this network returns none</span>
                  )}
                </div>
                {/* Only asked when there is something to ask about. /api/tx queries OUR
                    node, which has never heard of a Crosslink transaction and could not
                    look one up without an id anyway. */}
                {tx.txid && (
                  <div style={rowLine}>
                    <span style={{ color: muted(55) }}>our node</span>
                    <span style={{ fontWeight: 700, textAlign: "right", maxWidth: "62%" }}>
                      {txSeen === null
                        ? "checking…"
                        : txSeen.known === true
                          ? txSeen.confirmations
                            ? `seen it, ${txSeen.confirmations} confirmation${txSeen.confirmations === 1 ? "" : "s"}`
                            : "seen it, in the mempool"
                          : txSeen.known === false
                            ? "not seen yet"
                            : "cannot say right now"}
                    </span>
                  </div>
                )}
                <div style={rowLine}>
                  <span style={{ color: muted(55) }}>privacy</span>
                  <span style={{ fontWeight: 700, textAlign: "right", maxWidth: "62%" }}>
                    {tx.priv ? <span className="tag tag-outline" style={{ fontSize: 9 }}>shielded z→z</span> : "transparent, public on-chain"}
                  </span>
                </div>
                <div style={rowLine}>
                  <span style={{ color: muted(55) }}>network</span>
                  {/* The chain's name and nothing else. Appending the beta marker read
                      "Crosslink feature net · feature net, beta", which says the same
                      thing twice and is the sort of line that only shows up once it is
                      in front of you. The marker's job is done at the toggle, where it
                      is a warning before the choice rather than a label after it. */}
                  <span style={{ fontWeight: 700 }}>{networkFacts(tx.network).chain}</span>
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {/* No copy-txid and no explorer link when there is no id: a disabled
                    button offering something that does not exist is worse than the
                    button not being there (#323 ruling). Both keyed off the data. */}
                {tx.txid && <button className="btn btn-secondary btn-sm" onClick={() => void copy("txid", tx.txid!)}>{copied === "txid" ? "Copied ✓" : "Copy txid"}</button>}
                <button className="btn btn-secondary btn-sm" onClick={() => void copy("receipt", receiptText(tx))}>{copied === "receipt" ? "Copied ✓" : "Copy receipt"}</button>
                {genKey && genKey.address === tx.to && <button className="btn btn-secondary btn-sm" aria-label="Copy spending key" onClick={() => void copy("key", genKey.secret)}>{copied === "key" ? "Copied ✓" : "Copy spending key"}</button>}
                {tx.explorerUrl && <a className="btn btn-secondary btn-sm" href={tx.explorerUrl} target="_blank" rel="noreferrer">Open in explorer ↗</a>}
                <button className="btn btn-ghost btn-sm" onClick={again} style={{ padding: 0 }}>Another address</button>
              </div>
              <p aria-live="polite" className="sr-only">{copied === "txid" ? "Transaction id copied." : copied === "receipt" ? "Receipt copied." : ""}</p>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: muted(55) }}>
                {!tx.txid
                  ? networkFacts(tx.network).noTxidReason
                  : tx.priv
                    ? "Shielded sends take a moment to show up in an explorer, and the amount stays private there."
                    : "It can take a minute to appear in an explorer while the transaction is mined."}
              </p>
            </div>
          </div>
        )}

        {phase === "cooldown" && (() => {
          /* TWO SCREENS, because a paid address and a full connection are different
             situations with different advice. The old single card said "Come back in
             23h 58m" and offered "Try a different address" for BOTH - and a user who was
             refused by the connection limit, holding a confirmed drip, read that as the
             faucet being down and said so on the forum. A different address would not
             have helped him, and the card told him to try exactly that.

             THE SERVER'S REASON, NOT OUR GUESS AT IT. An earlier version invented "<address>
             got its 0.5 cTAZ" and was wrong about both the address and the asset. The API
             says which limit refused; this renders that. And it renders the time as a
             clock reading - a person can act on "09:21 tomorrow"; "83400 seconds" is
             homework.

             THE RECEIPT IS THIS BROWSER'S OWN. It is never asked of the server (that was an
             address-to-txid oracle, see rememberReceipt) and it is never shown for a
             connection refusal, where the blocking drip may be someone else's on the same
             router. */
          const r = refusal;
          const when = r?.nextAt ? new Date(r.nextAt) : cooldownEnd ? new Date(cooldownEnd) : null;
          const whenText = when
            ? when.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", weekday: "short", timeZoneName: "short" })
            : null;
          if (r?.kind === "connection" || r?.kind === "subnet") {
            // The subnet refusal carries a fixed hour, not a measured expiry, and the
            // server sends no nextAt for it - so no clock time is promised here either.
            // Rendering one next to the reason's own "try again tomorrow" put two
            // contradictory times on one card.
            const sub = r.kind === "subnet";
            return (
              <div style={{ border: "2px solid var(--color-divider)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                <span style={kicker}>{sub ? "Network limit reached" : "Connection limit reached"}</span>
                <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.25 }}>{sub ? "Your network is over its quota for now." : "This connection is out of drips for now."}</h2>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(62) }}>
                  {r.reason || "Everyone on the same network shares this limit."}{" "}
                  {!sub && whenText ? <>A slot frees at <strong>{whenText}</strong> (in {dur(remain)}).</> : null}
                </p>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(62) }}>
                  The faucet is up. This is a limit, not a fault.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}><button className="btn btn-ghost btn-sm" onClick={again} style={{ padding: 0 }}>Start over</button></div>
              </div>
            );
          }
          const rc = r?.receipt ?? null;
          return (
            <div style={{ border: "2px solid var(--color-divider)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              <span style={kicker}>{rc ? "Already paid" : "Already claimed"}</span>
              <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.25 }}>
                {rc ? `This address got its ${rc.amountText}.` : "This address already claimed recently."}
              </h2>
              {rc?.txid && (
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                  <code data-testid="cooldown-txid" style={{ fontSize: 12, wordBreak: "break-all" }}>{rc.txid}</code>
                  <button className="btn btn-secondary btn-sm" onClick={() => void copy("txid", rc.txid!)}>{copied === "txid" ? "Copied" : "Copy"}</button>
                  {rc.explorerUrl && <a className="btn btn-secondary btn-sm" href={rc.explorerUrl} target="_blank" rel="noreferrer">Open in explorer ↗</a>}
                </div>
              )}
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(62) }}>
                {r?.reason || "This claim is on cooldown."}{" "}
                {whenText ? <>The next drip for this address is available at <strong>{whenText}</strong> (in {dur(remain)}).</> : <>The next one is available in {dur(remain)}.</>}
              </p>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(62) }}>
                The faucet is up. This is a limit, not a fault.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}><button className="btn btn-secondary btn-sm" onClick={again}>Try a different address</button></div>
            </div>
          );
        })()}

        {phase === "error" && (() => {
          // Each card says only what is true of its refusal. The button set follows: a
          // Try again that would re-solve a proof-of-work into the same refusal is not
          // offered, and the 504's is the one that would land on a 429 with no receipt.
          const k = fail.kind;
          const waitMs = fail.retryAt != null ? fail.retryAt - now : 0;
          const waitS = Math.max(0, Math.ceil(waitMs / 1000));
          const when = fail.retryAt != null
            ? new Date(fail.retryAt).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", weekday: "short", timeZoneName: "short" })
            : null;
          const kick =
            k === "held" ? "Our side, not yours"
            : k === "busy" ? "Busy, nothing left the wallet"
            : k === "cap" ? `Today\u2019s ${networkFacts(network).ticker} budget is spent`
            : k === "unknown" ? "Submitted, outcome unknown"
            : k === "bad" ? "Couldn\u2019t take that request"
            : k === "pow" ? "Human check failed, nothing was claimed"
            : k === "offline" ? "No answer from the faucet"
            : "Send failed, nothing left the wallet";
          const head =
            k === "held" ? "Not right now."
            : k === "busy" ? "Every send slot is taken."
            : k === "cap" ? `The faucet has paid out its daily ${networkFacts(network).ticker}.`
            : k === "unknown" ? "We lost track of your drip."
            : k === "bad" ? "Something in the request needs fixing."
            : "That didn\u2019t go through.";
          // Which sentence follows theirs. The server's own is shown as sent; the
          // page adds only what it knows and the server does not: the clock, the
          // address to watch, and that the address's cooldown is spent either way.
          const tail =
            k === "cap" && when ? ` It should have room again around ${when}.`
            : k === "held" && waitS > 0 ? ` You can try again in ${waitS}s.`
            : k === "held" ? " You can try again now."
            : k === "unknown" ? " Its cooldown was spent on this claim, so a retry would be refused either way."
            : "";
          const tryAgain = k === "failed" || k === "pow" || k === "offline" || k === "busy" || k === "held";
          return (
            <div role="alert" style={{ border: "2px solid var(--color-accent)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 11 }}>
              <span style={kicker}>{kick}</span>
              <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.25 }}>{head}</h2>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(70), maxWidth: "52ch" }}>{errMsg}{tail}</p>
              {k === "unknown" && fail.address && (
                <code data-testid="unknown-address" style={{ fontFamily: "var(--mono)", fontSize: 12, wordBreak: "break-all", color: "var(--color-text)" }}>{fail.address}</code>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {tryAgain && (
                  <button data-testid="error-retry" className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={k === "held" && waitS > 0}>
                    {k === "held" && waitS > 0 ? `Try again in ${waitS}s` : "Try again"}
                  </button>
                )}
                {k === "bad" && (
                  <button data-testid="error-edit" className="btn btn-primary btn-sm" onClick={() => { setErrMsg(""); setPhase(basePhase(status, network)); }}>Edit the address</button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={again} style={{ padding: 0 }}>Start over</button>
              </div>
              {fail.requestId && (
                <p data-testid="request-id" style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 11, color: muted(55) }}>
                  ref {fail.requestId}{" "}
                  <span style={{ fontFamily: "inherit" }}>· quote it if you <a href="/terms" style={{ color: "inherit" }}>write to us</a></span>
                </p>
              )}
            </div>
          );
        })()}

        <div className="hr" style={{ margin: "6px 0 0" }} />

        {/* Who we are, AFTER the thing you came to do. Above the form this was a
            third and fourth block of type between the headline and the field, which
            is brand copy standing in the way of an action. Below it, it is what you
            read once the request is placed, which is when "who runs this" actually
            becomes an interesting question. */}
        <div className="about-strip">
          <p className="self-hosted-claim">
            <span>Own node</span>
            <span>Own wallet</span>
            <span>Shielded drips</span>
          </p>
          <p className="about-strip-line">
            We run the whole stack ourselves, and the community keeps it full.{" "}
            <a href="/donate">Chip in</a> if it saved you time.
          </p>
          {/* DRIPS SERVED, ON THE LANDING PAGE. It was rendered only inside More
              details, where the owner looked straight past it while asking where
              it was; a number nobody finds is not published. Absent stays absent
              rather than rendering a zero, which would read as "never served
              anyone" on the one line meant to show the opposite. The 7-day figure
              rides along only when it is non-zero, so a quiet week says nothing
              instead of advertising a nought. */}
          {status?.drips && status.drips.allTime > 0 ? (
            <p className="about-strip-line drips-line">
              <strong>{num(status.drips.allTime)}</strong> {status.drips.allTime === 1 ? "drip" : "drips"} served
              {status.drips.last7d > 0 ? <> · <strong>{num(status.drips.last7d)}</strong> in the last 7 days</> : null}
            </p>
          ) : null}
        </div>

            </article>
          </div>
        </section>

        <section className="view" data-view="status" data-testid="view-status" aria-label="Status" hidden={view !== "status"}>
          <div className="vhead">
            <h2>Status</h2>
            <p>What the node can prove right now, polled every 15 s. One word per state, and the details are for the operator.</p>
          </div>
          <StatusCards status={status} network={network} />
        </section>

        <section className="view" data-view="analytics" data-testid="view-analytics" aria-label="Usage analytics" hidden={view !== "analytics"}>
          <div className="vhead">
            <h2>Usage</h2>
            <p>Aggregate counts by UTC day from <code className="mono">/api/status</code>. Nothing per user is collected, so nothing per user is shown.</p>
          </div>
          <AnalyticsCards status={status} />
        </section>

        <section className="view" data-view="tools" data-testid="view-tools" aria-label="Tools" hidden={view !== "tools"}>
          <div className="vhead">
            <h2>Tools</h2>
            <p>A balance lookup for testnet addresses, and how the faucet is run.</p>
          </div>
          <ToolsCards
            status={status}
            address={lookupAddr}
            onAddressChange={(v) => { setLookupAddr(v); setLookupRes(""); }}
            onLookup={doLookup}
            result={lookupRes}
            incomeSentence={incomeFrom(status)}
          />
        </section>

      </main>
    </Shell>
  );
}
