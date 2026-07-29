import { test } from "node:test";
import assert from "node:assert/strict";
import { tipProgress, TIP_STALL_MS, type TipSample } from "./tipProgress.ts";

const T0 = 1_700_000_000_000;
const OURS = 4_220_000;
// A network tip that keeps moving, so the quiet-network suppression is not
// accidentally in force in the tests that are about our own node standing still.
const moving = (n: number) => OURS + 3 + n;
const sample = (height: number, at: number, externalHeight: number | null): TipSample => ({ height, at, externalHeight });

test("the first observation cannot be a stall", () => {
  // A fresh process has looked once. Reporting frozen on that would be claiming a
  // verdict from no evidence, which is the mistake this whole layer exists to stop.
  const p = tipProgress(null, OURS, moving(0), T0);
  assert.equal(p.stalled, false);
  assert.equal(p.stalledMs, null);
  assert.deepEqual(p.next, sample(OURS, T0, moving(0)));
});

test("a moving tip is never stalled, however long between polls", () => {
  const p = tipProgress(sample(OURS, T0, moving(0)), OURS + 1, moving(1), T0 + TIP_STALL_MS * 10);
  assert.equal(p.stalled, false);
  assert.equal(p.stalledMs, 0);
  assert.equal(p.next.height, OURS + 1);
});

test("unchanged but inside the window is not yet a stall", () => {
  const p = tipProgress(sample(OURS, T0, moving(0)), OURS, moving(1), T0 + TIP_STALL_MS - 1);
  assert.equal(p.stalled, false);
  assert.equal(p.stalledMs, TIP_STALL_MS - 1);
});

test("unchanged past the window, while the network moves on, is a stall", () => {
  const p = tipProgress(sample(OURS, T0, moving(0)), OURS, moving(20), T0 + TIP_STALL_MS);
  assert.equal(p.stalled, true);
  assert.equal(p.networkQuiet, false);
});

test("the stall clock measures from when the tip STOPPED, not from the last poll", () => {
  // The bug this guards: carrying the timestamp forward on every unchanged poll
  // would reset the clock each time and a permanently wedged node would never be
  // called stalled, because no two consecutive polls are far enough apart.
  let prev: TipSample | null = sample(OURS, T0, moving(0));
  let last;
  for (let i = 1; i <= 30; i++) {
    last = tipProgress(prev, OURS, moving(i), T0 + i * 60_000);
    prev = last.next;
  }
  assert.equal(last!.stalled, true, "30 minutes of one-minute polls must register as stalled");
  assert.equal(last!.stalledMs, 30 * 60_000);
});

test("a stall ends the moment the tip moves again", () => {
  const stalled = tipProgress(sample(OURS, T0, moving(0)), OURS, moving(20), T0 + TIP_STALL_MS);
  assert.equal(stalled.stalled, true);
  const recovered = tipProgress(stalled.next, OURS + 1, moving(21), T0 + TIP_STALL_MS + 1000);
  assert.equal(recovered.stalled, false);
  assert.equal(recovered.stalledMs, 0);
});

test("A QUIET NETWORK IS NOT OUR FAULT: no stall when the external tip is also static", () => {
  // Without this, a testnet that produces no block for 20 minutes would drive
  // stalled -> frozen -> /api/ready 503 and take a perfectly healthy faucet
  // offline. That is the direction #170 exists to avoid.
  const p = tipProgress(sample(OURS, T0, 4_220_003), OURS, 4_220_003, T0 + TIP_STALL_MS * 3);
  assert.equal(p.networkQuiet, true);
  assert.equal(p.stalled, false, "the network stopped too, so our node is not the fault");
  assert.equal(p.stalledMs, TIP_STALL_MS * 3, "still reported, so the condition stays visible");
});

test("but a network that moved while we did not IS our fault", () => {
  const p = tipProgress(sample(OURS, T0, 4_220_003), OURS, 4_220_500, T0 + TIP_STALL_MS);
  assert.equal(p.networkQuiet, false);
  assert.equal(p.stalled, true);
});

test("WITH THE ORACLE DOWN THE STALL STILL FIRES, which is the point of a motion signal", () => {
  // A null external tip must not suppress the stall: motion detection exists
  // precisely so it keeps working when the distance check has gone quiet, and those
  // two outages are not independent.
  const p = tipProgress(sample(OURS, T0, null), OURS, null, T0 + TIP_STALL_MS);
  assert.equal(p.networkQuiet, false);
  assert.equal(p.stalled, true);
});

test("an external tip that becomes known mid-stall does not retroactively suppress", () => {
  // prev.externalHeight is null (unknown when our tip froze), so there is nothing to
  // compare against and we must not infer the network was quiet.
  const p = tipProgress(sample(OURS, T0, null), OURS, 4_220_500, T0 + TIP_STALL_MS);
  assert.equal(p.networkQuiet, false);
  assert.equal(p.stalled, true);
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
  const p = tipProgress(sample(OURS, T0, moving(0)), OURS - 10, moving(5), T0 + TIP_STALL_MS);
  assert.equal(p.stalled, false);
});
