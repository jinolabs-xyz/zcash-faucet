/**
 * The two properties the field exists for, and the second one is the whole point.
 *
 * Monotonic across polls says the number is an age rather than a constant. FALLING across a
 * restart is what makes "did it restart" observable - and it is the property a monotonicity
 * check cannot see, because a counter that never resets is monotonic too. That distinction
 * is the bug this field was added for: `reserve.blindTicks` looked monotonic across
 * two-minute samples while resetting three times between them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { uptimeReading } from "./uptime.ts";

const NOW = Date.parse("2026-09-15T17:00:00Z");

test("a fresh process is under a minute old, and says so in whole seconds", () => {
  assert.equal(uptimeReading(0, NOW).uptimeSeconds, 0);
  assert.equal(uptimeReading(59.9, NOW).uptimeSeconds, 59, "floored: 59.9 s is not a minute up");
  assert.ok(uptimeReading(12.3, NOW).uptimeSeconds < 60);
});

test("it rises with the process's age, poll after poll", () => {
  const seen = [0.4, 30.2, 61.8, 3600].map((s) => uptimeReading(s, NOW).uptimeSeconds);
  assert.deepEqual(seen, [0, 30, 61, 3600]);
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] > seen[i - 1], `poll ${i} did not rise`);
});

test("AND IT FALLS WHEN THE PROCESS IS REPLACED, which is the property a monotonic check cannot see", () => {
  // The old process at an hour, the new one seconds after the swap. A counter that only
  // ever climbs would report the same shape for a restart and for no restart at all,
  // which is exactly how three restarts hid inside blindTicks' 3 -> 45 -> 59.
  const before = uptimeReading(3600, NOW).uptimeSeconds;
  const after = uptimeReading(4, NOW + 4000).uptimeSeconds;
  assert.ok(after < before, `uptime must drop across a restart: ${before} then ${after}`);
  assert.equal(after, 4);
});

test("startedAt is the same instant, at full precision, and does not inherit the public rounding", () => {
  // Two fields describing one moment must not disagree. The public count is floored; the
  // operator's instant is computed from the unrounded age, so it is exact.
  const r = uptimeReading(59.9, NOW);
  assert.equal(r.uptimeSeconds, 59);
  assert.equal(r.startedAt, new Date(NOW - 59_900).toISOString());
  assert.equal(new Date(r.startedAt).getTime(), NOW - 59_900, "not floored to the nearest second");
});

test("a start in the future is clamped rather than published", () => {
  // Not reachable from process.uptime(), and a negative age on a status page would be read
  // as a broken box rather than as a clock that moved.
  const r = uptimeReading(-5, NOW);
  assert.equal(r.uptimeSeconds, 0);
  assert.equal(r.startedAt, new Date(NOW).toISOString());
});
