import { test } from "node:test";
import assert from "node:assert/strict";
import { tipProgress, TIP_STALL_MS } from "./tipProgress.ts";

const T0 = 1_700_000_000_000;

test("the first observation cannot be a stall", () => {
  // A fresh process has looked once. Reporting frozen on that would be claiming a
  // verdict from no evidence, which is the mistake this whole layer exists to stop.
  const p = tipProgress(null, 4_220_000, T0);
  assert.equal(p.stalled, false);
  assert.equal(p.stalledMs, null);
  assert.deepEqual(p.next, { height: 4_220_000, at: T0 });
});

test("a moving tip is never stalled, however long between polls", () => {
  const prev = { height: 4_220_000, at: T0 };
  const p = tipProgress(prev, 4_220_001, T0 + TIP_STALL_MS * 10);
  assert.equal(p.stalled, false);
  assert.equal(p.stalledMs, 0);
  assert.deepEqual(p.next, { height: 4_220_001, at: T0 + TIP_STALL_MS * 10 });
});

test("unchanged but inside the window is not yet a stall", () => {
  const prev = { height: 4_220_000, at: T0 };
  const p = tipProgress(prev, 4_220_000, T0 + TIP_STALL_MS - 1);
  assert.equal(p.stalled, false);
  assert.equal(p.stalledMs, TIP_STALL_MS - 1);
});

test("unchanged past the window is a stall", () => {
  const prev = { height: 4_220_000, at: T0 };
  const p = tipProgress(prev, 4_220_000, T0 + TIP_STALL_MS);
  assert.equal(p.stalled, true);
  assert.equal(p.stalledMs, TIP_STALL_MS);
});

test("the stall clock measures from when the tip STOPPED, not from the last poll", () => {
  // The bug this guards: carrying the timestamp forward on every unchanged poll
  // would reset the clock each time and a permanently wedged node would never be
  // called stalled, because no two consecutive polls are far enough apart.
  let prev: { height: number; at: number } | null = { height: 4_220_000, at: T0 };
  let last;
  for (let i = 1; i <= 30; i++) {
    // poll every minute, tip never moves
    last = tipProgress(prev, 4_220_000, T0 + i * 60_000);
    prev = last.next;
  }
  assert.equal(last!.stalled, true, "30 minutes of one-minute polls must register as stalled");
  assert.equal(last!.stalledMs, 30 * 60_000);
});

test("a stall ends the moment the tip moves again", () => {
  const stuckFor = { height: 4_220_000, at: T0 };
  const stalled = tipProgress(stuckFor, 4_220_000, T0 + TIP_STALL_MS);
  assert.equal(stalled.stalled, true);
  const recovered = tipProgress(stalled.next, 4_220_001, T0 + TIP_STALL_MS + 1000);
  assert.equal(recovered.stalled, false);
  assert.equal(recovered.stalledMs, 0);
});

test("the window is far longer than any test run, so a fixed-height double cannot trip it", () => {
  // fake-zallet reports a constant NODE_TIP. If the stall window were short, the
  // integration suite would start reporting a frozen node partway through a run —
  // trading one environment-dependent failure for another.
  assert.ok(
    TIP_STALL_MS >= 10 * 60_000,
    `stall window ${TIP_STALL_MS}ms is short enough that a test double could trip it`,
  );
});

test("a node that goes BACKWARDS counts as motion, not a stall", () => {
  // A reorg or a rollback is a different fault and the gap check owns it. Here the
  // only question is whether the tip is moving at all, and it plainly is.
  const p = tipProgress({ height: 4_220_000, at: T0 }, 4_219_990, T0 + TIP_STALL_MS);
  assert.equal(p.stalled, false);
});
