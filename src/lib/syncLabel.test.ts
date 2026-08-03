import { test } from "node:test";
import assert from "node:assert/strict";
import { syncLabel, syncBarWidth } from "./syncLabel.ts";

test("an unready node never reads 100%, however close it is", () => {
  // The exact production values from the 2026-08-03 incident, which rounded to
  // "100%" beside a "Syncing the node" headline for several minutes.
  assert.equal(syncLabel(99.99447457323753, false), "99.99%");
  assert.equal(syncLabel(99.99969303206399, false), "99.99%");
  assert.equal(syncLabel(100, false), "99.99%", "even a literal 100 is capped while unready");
  assert.notEqual(syncLabel(99.999999, false), "100%");
});

test("the number MOVES across the final stretch, which is the whole point", () => {
  const seen = [99.91, 99.94, 99.97, 99.99].map((p) => syncLabel(p, false));
  assert.equal(new Set(seen).size, seen.length, `stuck reading: ${seen.join(" ")}`);
});

test("ready is the only thing that earns 100%", () => {
  assert.equal(syncLabel(100, true), "100%");
  assert.equal(syncLabel(99.5, true), "100%", "ready wins: the node has spoken");
});

test("coarser figures stay coarse, so early sync is not false precision", () => {
  assert.equal(syncLabel(42.7, false), "42%");
  assert.equal(syncLabel(99.4, false), "99.4%");
});

test("unknown stays unknown", () => {
  assert.equal(syncLabel(null, false), null);
  assert.equal(syncLabel(null, true), null);
});

test("the bar never fills while unready", () => {
  assert.equal(syncBarWidth(99.99, false), "99.5%");
  assert.equal(syncBarWidth(100, true), "100%");
});
