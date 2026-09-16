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
  heightDiffChip,
  heightNote,
  heightTone,
  syncFigure,
  syncBarPercent,
  dripsLeft,
  dripsLeftText,
  reserveSentence,
  reserveTone,
  reserveWord,
  reserveChipTone,
  ctazWord,
  minerWord,
  minerTone,
  acceptPercent,
  acceptSentence,
  backendHost,
} from "./statusView.ts";
import { minerIsBad, readingFromStatus } from "./minerLabel.ts";

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

  // THE HERO CHIP IS NOT heightDeltaText IN BRACKETS, and the only case that shows it is a
  // non-zero delta. The snapshot's `derived.heightDiffChip` is `(${sgn} vs network)` with the
  // direction word kept in a separate field, so the two forms coincide at zero and diverge
  // everywhere else. Pinning zero alone would pass a wrap of heightDeltaText, which is the fix
  // the original finding implied - so the non-zero cases are the assertion and zero is the
  // control.
  assert.equal(heightDiffChip(0), "(+0 vs network)");
  assert.equal(heightDiffChip(8), "(+8 vs network)");
  assert.equal(heightDiffChip(-3), "(-3 vs network)");
  assert.equal(heightDiffChip(4_000), "(+4,000 vs network)");
  assert.equal(heightDiffChip(null), null);
  for (const d of [8, -3, 4_000]) {
    assert.notEqual(heightDiffChip(d), `(${heightDeltaText(d)})`,
      "a wrap of heightDeltaText would carry the direction word the design keeps elsewhere");
  }
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

test("drips-left is computed from SPENDABLE, and an unreadable spendable is not the total", () => {
  // The two are different quantities and the wallet card shows both: the figure is
  // everything the wallet holds, this line is what we can actually pay out. Coinbase we
  // have not shielded is in the first and not the second, so a card that fell back to the
  // total when the spendable read failed would overstate the faucet's reach at exactly the
  // moment it knows least. The preview computes it from spendable only; so does this.
  assert.equal(dripsLeftText(null, 0.1), "balance unknown");
  assert.equal(dripsLeftText(PROD.reserve.spendableTaz, PROD.dripTaz), "about 45,100 drips at 0.1");
  // A known total beside an unknown spendable is a legitimate state, not a contradiction
  // to paper over: the two must not produce the same sentence.
  assert.notEqual(dripsLeftText(null, 0.1), dripsLeftText(PROD.balanceTaz, PROD.dripTaz));
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

test("a STALLED miner on an inactive unit is still a fault, not a parked one", () => {
  // FOUND BY A SURVIVING MUTANT, and it is the assertion the test above only looked like
  // it was making. Deleting the heartbeat half of minerLabel's parked() - so that
  // `unit === "inactive"` alone decides - leaves every case above green, because
  // minerChip switches on the STATE first and never consults parked() for a running
  // miner. The half is load-bearing in exactly one place, minerIsBad, and this is it: a
  // miner that is stalled while systemd's word is stale would stop being marked at all.
  const stalled = { state: "stalled", active: false, beatAgoSeconds: 4, templateAgoSeconds: 9000 } as const;
  assert.equal(minerWord(stalled, "inactive"), "no blocks");
  assert.equal(minerTone(stalled, "inactive"), "bad", "a stale 'inactive' must not calm a stalled miner");
  assert.notEqual(minerTone(stalled, "inactive"), "warn");
});

test("a node with NO PEERS is marked on the miner, because it shows nowhere else", () => {
  // An isolated node sits at its OWN tip, so the node row stays green and its lag reads
  // zero. minerIsBad carries this and the first version of minerTone threw it away by
  // painting every waiting miner "warn". Two minutes is the threshold, so a node that
  // has just restarted does not flash red on every deploy.
  const settling = { state: "waiting", active: false, beatAgoSeconds: 3, waitingReason: "no-peers", waitingAgoSeconds: 30 } as const;
  const isolated = { state: "waiting", active: false, beatAgoSeconds: 3, waitingReason: "no-peers", waitingAgoSeconds: 600 } as const;
  assert.equal(minerTone(settling, "active"), "warn", "the first two minutes are a restart, not a finding");
  assert.equal(minerTone(isolated, "active"), "bad");
  // And the ordinary case is still not a fault: the node row beside it carries that one.
  assert.equal(minerTone({ state: "waiting", active: false, beatAgoSeconds: 3, nodeLag: 40 } as const, "active"), "warn");
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

test("chip, tone and isBad never disagree about a stopped miner, at any heartbeat age", () => {
  // THE PROPERTY SDE-APP'S #567 BLOCK IS ABOUT, and it is about coupling rather than about
  // any one answer. Three readers ask "is this miner parked": minerChip for the word,
  // minerIsBad for the judgement, and minerTone for the colour. They must never give three
  // answers for one state - "no signal" beside a calm grey beside a fault is the exact
  // thing minerTone's own header says it exists to prevent.
  //
  // The heartbeat ages straddle the boundary a plausible edit to the predicate would add,
  // so a rule change moves every reader or this goes red.
  for (const beatAgoSeconds of [2, 60, 3599, 3601, 52200]) {
    const r = { state: "not-writing", active: false, beatAgoSeconds } as const;
    const chip = minerWord(r, "inactive");
    const tone = minerTone(r, "inactive");
    const bad = minerIsBad(readingFromStatus(r), "inactive");
    const calm = chip === "parked";
    assert.equal(tone === "unknown", calm,
      `beat ${beatAgoSeconds}s: the word is "${chip}" and the colour is "${tone}"`);
    assert.equal(bad, !calm,
      `beat ${beatAgoSeconds}s: the word is "${chip}" and minerIsBad says ${bad}`);
  }
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

/* ── the reserve chip's word ──────────────────────────────────────────────
 *
 * These exist because the review drove a case I had not: spendable 400 against a low mark of
 * 500 and a target of 1000 rendered `empty [bad]` beside a status card offering about 4,000
 * drips. "empty" is not a word the approved design uses anywhere, and it was reachable because
 * the word was derived from the TONE - three values - when the design derives it from the
 * FACTS, which need four.
 */
test("the chip never says a word the approved design does not use", () => {
  const words = new Set<string>();
  for (const spendableTaz of [0, 1, 400, 499, 500, 501, 999, 1000, 4506])
    for (const refilling of [true, false])
      words.add(reserveWord({ spendableTaz, lowTaz: 500, targetTaz: 1000, refilling }));
  words.add(reserveWord({ spendableTaz: null, lowTaz: 500, targetTaz: 1000 }));
  words.add(reserveWord(null));
  // index.html:932 produces exactly these three, plus unknown for a reserve we cannot read.
  assert.deepEqual([...words].sort(), ["low", "ok", "topping up", "unknown"]);
  assert.ok(!words.has("empty"), "empty is not a word this design has");
});

test("the review's own case reads topping up rather than empty when the reserve is refilling", () => {
  const r = { spendableTaz: 400, lowTaz: 500, targetTaz: 1000 };
  assert.equal(reserveWord({ ...r, refilling: true }), "topping up");
  assert.equal(reserveChipTone(reserveWord({ ...r, refilling: true })), "warn");
  // Not refilling and under the low mark is the design's "low", never "empty".
  assert.equal(reserveWord({ ...r, refilling: false }), "low");
  assert.equal(reserveChipTone(reserveWord({ ...r, refilling: false })), "bad");
});

test("refilling wins over the wallet tone, in both directions, the way index.html:932 orders it", () => {
  // Above the target and refilling still says topping up: the spec tests `refilling` FIRST.
  assert.equal(reserveWord({ spendableTaz: 4506, lowTaz: 500, targetTaz: 1000, refilling: true }), "topping up");
  assert.equal(reserveWord({ spendableTaz: 4506, lowTaz: 500, targetTaz: 1000, refilling: false }), "ok");
  // Between the low mark and the target, not refilling, is "ok" and not "low": the spec keys
  // the word on `wt === 'bad'`, which is at-or-below the LOW mark, not below the target.
  assert.equal(reserveWord({ spendableTaz: 900, lowTaz: 500, targetTaz: 1000, refilling: false }), "ok");
  assert.equal(reserveTone({ spendableTaz: 900, lowTaz: 500, targetTaz: 1000 }), "warn");
});

test("a reserve we cannot read says unknown rather than claiming it is topping up", () => {
  // refilling true with no numbers behind it is still a claim we have not established.
  assert.equal(reserveWord({ spendableTaz: null, lowTaz: 500, targetTaz: 1000, refilling: true }), "unknown");
  assert.equal(reserveChipTone("unknown"), "unknown");
});

test("the chip's tone comes from the word and is never re-derived", () => {
  // The coupling that minerTone got wrong earlier in this PR, asserted here so the second
  // instance cannot drift either: every word maps to exactly one tone, per index.html:881.
  assert.equal(reserveChipTone("low"), "bad");
  assert.equal(reserveChipTone("topping up"), "warn");
  assert.equal(reserveChipTone("ok"), "ok");
  assert.equal(reserveChipTone("empty"), "unknown");
});

/* ── the cTAZ row's word ────────────────────────────────────────────────── */

test("the cTAZ row never says parked about a node the status reports as servable", () => {
  // The whole point of deriving it. A literal cannot fail this and that is why it was one.
  assert.notEqual(ctazWord({ enabled: true, servable: true }), "parked");
  assert.equal(ctazWord({ enabled: true, servable: true }), "unknown");
});

test("and it says parked for the two ways cTAZ is not serving", () => {
  assert.equal(ctazWord({ enabled: false, servable: false }), "parked");
  assert.equal(ctazWord({ enabled: true, servable: false }), "parked");
});

test("a status that told us nothing about cTAZ gets a claim about nothing", () => {
  assert.equal(ctazWord(null), "unknown");
  assert.equal(ctazWord(undefined), "unknown");
  assert.equal(ctazWord({}), "parked");   // present but silent on servable: not serving
});

test("today's production status produces exactly the word the preview hardcodes", () => {
  // enabled true, servable false. The transcription was faithful; it was just not derived.
  assert.equal(PROD.ctaz.enabled, true);
  assert.equal(PROD.ctaz.servable, false);
  assert.equal(ctazWord(PROD.ctaz), "parked");
});

test("the word is never a number, in any combination", () => {
  for (const enabled of [true, false, undefined])
    for (const servable of [true, false, undefined])
      assert.ok(Number.isNaN(Number(ctazWord({ enabled, servable }))),
        `${enabled}/${servable} produced a numeric word`);
});
