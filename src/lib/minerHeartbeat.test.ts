/**
 * The state this file exists for is `stalled`, because that is the one the old
 * env-flag field could not express. Every test below is written so it would FAIL
 * against the old `miner.active = FAUCET_MINER_ACTIVE === "true"`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMiner, isMinerProblem, STALE_AFTER_MS } from "./minerHeartbeat.ts";

const NOW = 1_700_000_000_000;
const hb = (agoMs: number, height: number | null = 4_227_652) => ({
  height, at: NOW - agoMs, readable: true,
});

test("a fresh template means mining, and says the height", () => {
  const s = classifyMiner(hb(5_000), true, NOW);
  assert.equal(s.state, "mining");
  assert.equal(s.lastTemplateAgoSeconds, 5);
  assert.match(s.reason, /4,227,652/);
  assert.equal(isMinerProblem(s), false);
});

test("THE 2026-07-31 CASE: switched on, process alive, no template for 70 minutes", () => {
  // The old field reported `on` for this exact state for 70 minutes. If this test
  // ever reports "mining", we have rebuilt the bug.
  const s = classifyMiner(hb(70 * 60_000), true, NOW);
  assert.equal(s.state, "stalled");
  assert.equal(isMinerProblem(s), true);
  assert.match(s.reason, /stale RPC cookie/);
});

test("just past the threshold is already stalled, not rounded away", () => {
  assert.equal(classifyMiner(hb(STALE_AFTER_MS + 1_000), true, NOW).state, "stalled");
});

test("just inside the threshold is still mining, so a slow tick is not an alarm", () => {
  assert.equal(classifyMiner(hb(STALE_AFTER_MS - 1_000), true, NOW).state, "mining");
});

test("a MISSING heartbeat is unknown, never off and never healthy", () => {
  // The distinction the whole module rests on. We were told to mine and cannot see
  // whether we are; that is not the same as being told not to mine.
  for (const missing of [null, { height: null, at: null, readable: false }]) {
    const s = classifyMiner(missing, true, NOW);
    assert.equal(s.state, "unknown");
    assert.equal(isMinerProblem(s), false, "unknown is not a proven fault");
    assert.match(s.reason, /unverified/);
  }
});

test("an unreadable heartbeat does not masquerade as a fresh one", () => {
  const s = classifyMiner({ height: 1, at: NOW, readable: false }, true, NOW);
  assert.equal(s.state, "unknown");
});

test("switched off is off, and does not depend on the heartbeat at all", () => {
  assert.equal(classifyMiner(hb(5_000), false, NOW).state, "off");
  assert.equal(classifyMiner(null, false, NOW).state, "off");
});

test("a clock skewed into the future does not read as a stale miner", () => {
  // now < at would make the age negative and, unclamped, sail under the threshold
  // in one direction and produce nonsense text in the other.
  const s = classifyMiner({ height: 5, at: NOW + 30_000, readable: true }, true, NOW);
  assert.equal(s.state, "mining");
  assert.equal(s.lastTemplateAgoSeconds, 0);
});

test("a template with no height still reports mining rather than failing", () => {
  const s = classifyMiner(hb(5_000, null), true, NOW);
  assert.equal(s.state, "mining");
  assert.doesNotMatch(s.reason, /null|undefined|NaN/);
});
