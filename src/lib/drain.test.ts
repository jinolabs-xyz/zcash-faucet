/**
 * The drain (risk register II, R-27): once told to stop, the process refuses new claims
 * and waits, bounded, for its send queues to empty.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const { drain, isDraining, resetDrainForTests } = await import("./drain.ts");
afterEach(() => resetDrainForTests());

test("draining is false until a signal, then true for the rest of the process's life", async () => {
  assert.equal(isDraining(), false);
  const emptied = await drain(() => 0, 1000, 5);
  assert.equal(emptied, true);
  assert.equal(isDraining(), true, "the flag stays up: a late claim must still be refused");
});

test("a busy queue is waited for, and the wait ends the moment it empties", async () => {
  let depth = 2;
  setTimeout(() => { depth = 1; }, 20);
  setTimeout(() => { depth = 0; }, 40);
  const t0 = Date.now();
  const emptied = await drain(() => depth, 5000, 5);
  assert.equal(emptied, true);
  assert.ok(Date.now() - t0 < 1000, "did not sit out the bound once the queue was empty");
});

test("a queue that never empties is given the bound and no more, and the caller is told", async () => {
  const t0 = Date.now();
  const emptied = await drain(() => 1, 60, 5);
  assert.equal(emptied, false);
  const took = Date.now() - t0;
  assert.ok(took >= 55 && took < 1000, `bounded at ~60ms, took ${took}ms`);
  assert.equal(isDraining(), true);
});
