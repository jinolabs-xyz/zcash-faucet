/**
 * The Status and Analytics figures, and most of these are about what a number must NOT
 * claim.
 *
 * The fixture is a VERBATIM /api/status response captured from production on
 * 2026-09-15, committed so that "against the real shape" is a fact rather than a
 * sentence in a PR body. Hand-written objects test the shape the author imagined; this
 * one has the fields production actually sends, including the four that were absent
 * from the page's own interface when this was written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  groupDigits,
  heightDiff,
  heightDeltaText,
  heightNote,
  heightTone,
  syncFigure,
  syncBarPercent,
  dripsLeft,
  dripsLeftText,
  reserveSentence,
  reserveTone,
  minerWord,
  minerTone,
  acceptPercent,
  acceptSentence,
  backendHost,
} from "./statusView.ts";

const PROD = JSON.parse(readFileSync(new URL("./fixtures/status.prod.json", import.meta.url), "utf8"));

/* ── the fixture is the real thing ────────────────────────────────────── */

test("the fixture carries the fields these views read, so the tests below are about production", () => {
  // If production drops one of these, this fails here with the field named rather than
  // as six confusing assertion failures further down.
  for (const path of [
    "node.nodeHeight", "node.externalHeight", "node.syncPercent", "node.ready",
    "reserve.spendableTaz", "reserve.lowTaz", "reserve.targetTaz",
    "miner.state", "miner.submittedAccepted", "miner.submittedRejected",
    "box.minerUnit", "backend.endpoint", "drips.byDay", "dripTaz",
  ]) {
    const v = path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], PROD);
    assert.notEqual(v, undefined, `the production fixture has no ${path}`);
  }
  assert.equal(PROD.drips.byDay.length, 30, "the series is 30 UTC days");
});

/* ── heights ──────────────────────────────────────────────────────────── */

test("a missing independent reference is not a difference of zero", () => {
  // The failure this prevents: "+0 vs network, level" for a node with nothing to be
  // level with. Level with what?
  assert.equal(heightDiff(4_351_175, null), null);
  assert.equal(heightDiff(null, 4_351_174), null);
  assert.equal(heightDeltaText(null), "no independent reference");
  assert.equal(heightNote(null), "nothing to compare against");
  assert.equal(heightTone(null), "unknown");
  // And it is distinguishable from a real zero, which IS a claim we can make.
  assert.equal(heightDiff(4_351_175, 4_351_175), 0);
  assert.equal(heightNote(0), "level with the reference");
});

test("production's +1 reads as ahead, and ahead is never marked", () => {
  const diff = heightDiff(PROD.node.nodeHeight, PROD.node.externalHeight);
  assert.equal(diff, 1);
  assert.equal(heightDeltaText(diff), "+1 vs network, ahead");
  assert.equal(heightNote(diff), "ahead, normal for a node that mines");
  // A node that mines is ahead of the reference by design. Marking it would teach a
  // reader that the normal state is a warning.
  assert.equal(heightTone(diff), "ok");
  assert.equal(heightTone(9_999), "ok");
});

test("behind is marked only once it is past ordinary propagation", () => {
  assert.equal(heightTone(-1), "ok", "one block behind is propagation, not a fault");
  assert.equal(heightTone(-2), "ok");
  assert.equal(heightTone(-3), "warn", "three behind is the shape of the 2026-09-15 fault");
  assert.equal(heightDeltaText(-3), "-3 vs network, behind");
  assert.equal(heightNote(-3), "behind the reference");
});

test("the height delta groups its digits, because a fork is five figures", () => {
  assert.equal(heightDeltaText(-12_345), "-12,345 vs network, behind");
  assert.equal(heightDeltaText(4_000), "+4,000 vs network, ahead");
});

/* ── sync ─────────────────────────────────────────────────────────────── */

test("an unready node never reads 100%, whatever its percentage says", () => {
  // THE PROPERTY THE PREVIEW WOULD HAVE LOST. syncLabel.ts bought this during the
  // 2026-08-03 incident, when a frozen "100%" sat beside "Syncing the node" for
  // minutes. The preview's version has no readiness input at all.
  assert.equal(syncFigure(100, false), "99.99%");
  assert.equal(syncFigure(99.99969303206399, false), "99.99%");
  assert.notEqual(syncFigure(100, false), "100.00%");
  // R-43 is exactly this state and it is not hypothetical: on 2026-09-15 the node sat
  // at the tip for five hours while the wallet scanned, ready false, syncPercent 100.
  assert.equal(syncFigure(100, true), "100.00%");
});

test("the sync figure floors to two decimals, so it never rounds up into a claim", () => {
  // The owner ruled two decimals. Floor rather than round for syncLabel's reason:
  // 99.994 rounding to "99.99" is honest, rounding to "100.00" is not.
  assert.equal(syncFigure(99.994, true), "99.99%");
  assert.equal(syncFigure(99.996, true), "99.99%");
  assert.equal(syncFigure(42.517, true), "42.51%");
  assert.equal(syncFigure(PROD.node.syncPercent, PROD.node.ready), "100.00%");
});

test("an unknown percentage is unknown, not zero and not full", () => {
  assert.equal(syncFigure(null, false), "unknown");
  assert.equal(syncFigure(undefined, true), "unknown");
  // The bar is the half that matters: a null percentage filling the bar would draw a
  // complete sync for a node we have not heard from.
  assert.equal(syncBarPercent(null, false), 0);
  assert.equal(syncBarPercent(null, true), 0);
  assert.equal(syncBarPercent(100, true), 100);
  assert.equal(syncBarPercent(100, false), 99.5, "unready never fills the bar either");
});

/* ── the wallet ───────────────────────────────────────────────────────── */

test("an unknown balance buys an unknown number of drips, never zero", () => {
  // A wallet we cannot read is not an empty wallet. The faucet has been in exactly this
  // state with a full wallet (2026-07-29), and "0 drips left" would have sent someone
  // to refill it.
  assert.equal(dripsLeft(null, 0.1), null);
  assert.equal(dripsLeftText(null, 0.1), "balance unknown");
  assert.equal(reserveTone({ spendableTaz: null, lowTaz: 500, targetTaz: 1000 }), "unknown");
  assert.notEqual(reserveTone({ spendableTaz: null, lowTaz: 500, targetTaz: 1000 }), "bad");
});

test("production's balance reads as the preview has it", () => {
  assert.equal(dripsLeft(PROD.reserve.spendableTaz, PROD.dripTaz), 45_100);
  assert.equal(dripsLeftText(PROD.reserve.spendableTaz, PROD.dripTaz), "about 45,100 drips at 0.1");
  assert.equal(
    reserveSentence(PROD.reserve, PROD.dripTaz),
    "4,507 TAZ · reserve line 1,000 · about 45,100 drips at 0.1",
  );
});

test("a drip size of zero does not divide", () => {
  // Configuration can be wrong and Infinity must not reach the page.
  assert.equal(dripsLeft(4506, 0), null);
  assert.equal(dripsLeftText(4506, 0), "balance unknown");
});

test("the reserve's tone turns at the marks it names", () => {
  const r = (spendableTaz: number) => reserveTone({ spendableTaz, lowTaz: 500, targetTaz: 1000 });
  assert.equal(r(4506), "ok");
  assert.equal(r(1000), "ok", "at target is not below target");
  assert.equal(r(999), "warn");
  assert.equal(r(501), "warn");
  assert.equal(r(500), "bad", "at the low mark is already bad");
  assert.equal(r(0), "bad");
  assert.equal(reserveTone(PROD.reserve), "ok");
});

test("the reserve sentence survives a reserve block it has never seen", () => {
  assert.equal(reserveSentence(undefined, 0.1), "spendable balance unknown right now · reserve line unknown");
  assert.equal(
    reserveSentence({ spendableTaz: 4506.87, targetTaz: null }, 0.1),
    "4,507 TAZ · reserve line unknown · about 45,100 drips at 0.1",
  );
});

/* ── the miner ────────────────────────────────────────────────────────── */

test("the miner word comes from the state machine, not from the preview's four lines", () => {
  // Production right now: the owner stopped the unit, the heartbeat stopped with it.
  // "parked" by the CTO's ruling of 2026-09-15, and it is also what the approved design
  // shows. It is one word and it is not a fault name, which is the standing rule here.
  assert.equal(minerWord(PROD.miner, PROD.box.minerUnit), "parked");
  assert.equal(minerTone(PROD.miner, PROD.box.minerUnit), "unknown", "stopped on purpose is not a fault and not green");
});

test("a miner waiting on a node that is behind is not stalled", () => {
  // THE PREVIEW SAYS "stalled" HERE, because it has no branch for waiting. The miner is
  // idling on purpose so it cannot build on a chain it should not; the node row beside
  // it carries the actual finding.
  const waiting = { state: "waiting", active: false, beatAgoSeconds: 3, nodeLag: 40 } as const;
  assert.equal(minerWord(waiting, "active"), "waiting");
  assert.notEqual(minerWord(waiting, "active"), "stalled");
  assert.equal(minerTone(waiting, "active"), "warn");
});

test("a live heartbeat is never overruled by a stale box report", () => {
  // THE PREVIEW RETURNS "parked" HERE, from box.minerUnit alone. minerLabel.ts requires
  // both halves and says why in its header: the heartbeat is the primary evidence. One
  // stale box report must not paint a running miner as stopped.
  const running = { state: "running", active: true, beatAgoSeconds: 2, mode: "submit" } as const;
  assert.equal(minerWord(running, "inactive"), "mining");
  assert.equal(minerTone(running, "inactive"), "ok");
});

test("we-are-not-watching and we-cannot-tell each read as themselves, not as a fault", () => {
  // The preview renders both as "stalled", which claims a broken miner for a deploy
  // that simply has no heartbeat path and for a response too old to carry a state.
  assert.equal(minerWord({ state: "not-configured", active: false } as const, null), "unwatched");
  assert.equal(minerTone({ state: "not-configured", active: false } as const, null), "unknown");
  assert.equal(minerWord({ active: true, beatAgoSeconds: 2 }, "active"), "unknown", "no state at all");
  assert.equal(minerTone({ active: true, beatAgoSeconds: 2 }, "active"), "unknown");
  assert.equal(minerWord(null, null), "unknown", "no miner block at all");
});

test("a failed unit keeps its own word and its own colour", () => {
  const dead = { state: "not-writing", active: false, beatAgoSeconds: 900 } as const;
  assert.equal(minerWord(dead, "failed"), "unit failed");
  assert.equal(minerTone(dead, "failed"), "bad");
  // The same heartbeat with no unit word is a wedged writer, which is a different job.
  assert.equal(minerWord(dead, null), "no signal");
  assert.equal(minerTone(dead, null), "bad");
});

test("proposal mode does not claim to be mining", () => {
  assert.equal(minerWord({ state: "running", active: true, mode: "proposal", beatAgoSeconds: 2 } as const, "active"), "proposing");
});

/* ── acceptance ───────────────────────────────────────────────────────── */

test("a miner that has submitted nothing has no acceptance rate", () => {
  // 0% is a measurement. Nothing submitted is the absence of one, and the two look
  // identical at zero while meaning entirely different things.
  assert.equal(acceptPercent({ submittedAccepted: 0, submittedRejected: 0 }), null);
  assert.equal(acceptSentence({ submittedAccepted: 0, submittedRejected: 0 }), "no blocks submitted yet");
  assert.equal(acceptPercent(null), null);
  assert.equal(acceptPercent({}), null);
  // A genuine zero rate, which IS a measurement, still reads as one.
  assert.equal(acceptPercent({ submittedAccepted: 0, submittedRejected: 12 }), 0);
  assert.equal(acceptSentence({ submittedAccepted: 0, submittedRejected: 12 }), "0% accepted by our node");
});

test("production's acceptance is 58%", () => {
  assert.equal(acceptPercent(PROD.miner), 58);
  assert.equal(acceptSentence(PROD.miner), "58% accepted by our node");
});

/* ── the backend ──────────────────────────────────────────────────────── */

test("the backend keeps its port when the scheme is dropped", () => {
  // :443 and :9067 are different answers to "why does the lookup fail", so the port is
  // not cosmetic even though the scheme is.
  assert.equal(backendHost(PROD.backend.endpoint), "testnet.zec.rocks:443");
  assert.equal(backendHost("http://127.0.0.1:9067"), "127.0.0.1:9067");
  assert.equal(backendHost(null), "unknown");
  assert.equal(backendHost(""), "unknown");
});

test("digit grouping", () => {
  assert.equal(groupDigits(4_351_175), "4,351,175");
  assert.equal(groupDigits(999), "999");
  assert.equal(groupDigits(1000), "1,000");
  assert.equal(groupDigits(0), "0");
  assert.equal(groupDigits(4506.871133), "4,506", "truncates rather than printing a decimal");
});
