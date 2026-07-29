/**
 * The reserve loop's repeating lines are sampled after the first few, and this
 * pins the two halves of that being safe.
 *
 * WHY IT EXISTS. Every repeating line in the loop was written to fire every tick,
 * because #172 was sixteen hours of a stalled loop looking identical to an idle
 * one and the silence WAS the bug. That is right for the first minutes and wrong
 * forever after: after the 2026-07-29 recovery the operator set low 100 and target
 * 1000 so future coinbase auto-sweeps, which leaves `refilling` held true with
 * nothing to sweep, so a perfectly healthy faucet emitted 2,880 identical error
 * lines a day.
 *
 * The danger in fixing it is obvious and is what these assertions are for: a
 * throttle that goes too quiet re-creates #172. So the rule has to stay loud while
 * the state is news, keep sampling forever after rather than stopping, and never
 * touch the counters that make the state readable between samples.
 *
 * Asserted against the shipped predicate rather than a copy of the arithmetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSay, sampledNote, LOUD_TICKS, SAMPLE_EVERY } from "./reconciler.ts";

test("the first ticks of a new state are always loud, because that is when it is news", () => {
  for (let n = 1; n <= LOUD_TICKS; n++) {
    assert.equal(shouldSay(n), true, `tick ${n} of a fresh problem must be said`);
  }
});

test("it keeps sampling forever rather than falling silent, which is the #172 trap", () => {
  // A throttle that stops is a loop that goes quiet while broken. Check far out,
  // because "it logged for a while then stopped" is exactly how #172 read.
  const saidLate = [500, 1000, 2000, 10_000].filter((n) => shouldSay(n * SAMPLE_EVERY));
  assert.deepEqual(
    saidLate,
    [500, 1000, 2000, 10_000],
    "a state that has been wrong for a day must still be saying so",
  );
});

test("the sampled rate is readable rather than a firehose", () => {
  // Count what a day of a stuck state actually produces at the default 30s tick.
  const ticksPerDay = (24 * 60 * 60) / 30;
  let lines = 0;
  for (let n = 1; n <= ticksPerDay; n++) if (shouldSay(n)) lines++;
  assert.ok(lines < 200, `${lines} lines a day is still a firehose`);
  assert.ok(lines > 100, `${lines} lines a day is too quiet to notice a stuck state`);
});

test("a sampled line SAYS it is sampling, so a gap is never read as a recovery", () => {
  // The subtle failure this avoids: an operator sees one line every ten minutes and
  // concludes the problem is intermittent, when it is continuous.
  assert.equal(sampledNote(1), "", "an early line is every occurrence, so no note");
  assert.match(sampledNote(SAMPLE_EVERY * 3), /sampling 1 in/);
  assert.match(sampledNote(SAMPLE_EVERY * 3), /continuous/);
});

test("the loud window and the sample rate are sane relative to each other", () => {
  // If SAMPLE_EVERY ever drops below LOUD_TICKS the throttle does nothing, and if
  // it grows very large the state goes effectively silent. Both are regressions
  // that would not fail any other assertion here.
  assert.ok(SAMPLE_EVERY > LOUD_TICKS, "sampling more often than the loud window is a no-op");
  assert.ok(SAMPLE_EVERY <= 60, `1 in ${SAMPLE_EVERY} is too quiet at a 30s tick`);
});
