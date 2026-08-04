/**
 * The bind-mount status file, and the four ways it can lie.
 *
 * The container cannot reach the node's RPC at all, so this file is the only thing standing
 * between the panel and a permanent cannot-verify. That makes its failure modes the whole
 * risk: an absent file, an unparseable one, a stale one and one that says the node did not
 * answer are FOUR different facts, and none of them is "the node is fine".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCtazStatusFile, statusIsStale, STATUS_STALE_AFTER_MS } from "./statusFile.ts";

const NOW = 1_800_000_000_000;
const dir = mkdtempSync(join(tmpdir(), "ctaz-status-"));
const write = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

test("a good file parses, and the percent survives as a number", () => {
  const p = write("ok.json", JSON.stringify({
    readable: true, at: NOW - 5_000, blocks: 293_300, tip: 293_300, syncPercent: 100, recency: { my_height: 293_300 },
  }));
  const f = readCtazStatusFile(p);
  assert.equal(f.readable, true);
  assert.equal(f.syncPercent, 100);
  assert.equal(f.blocks, 293_300);
  assert.equal(statusIsStale(f, NOW), false);
});

test("A MISSING FILE IS NOT AN ERROR AND NOT A ZERO", () => {
  // cTAZ is off by default, so on most deploys this file legitimately does not exist.
  // Every numeric field must be null, because 0% would say "barely started" about a node
  // that might be at tip, and that wrong number is worse than no number.
  const f = readCtazStatusFile(join(dir, "does-not-exist.json"));
  assert.equal(f.readable, false);
  assert.equal(f.syncPercent, null);
  assert.equal(f.blocks, null);
  assert.equal(f.at, null);
});

test("an empty path reads as absent rather than throwing", () => {
  // config.crosslink.statusFile can be set empty to disable the file path deliberately.
  const f = readCtazStatusFile("");
  assert.equal(f.readable, false);
  assert.equal(f.at, null);
});

test("TRUNCATED JSON IS ABSENT, not partially believed", () => {
  // What a reader catching a half-written file sees. The writer uses mv to make this
  // unreachable, and this is handled anyway, because "unreachable" is a claim about a
  // script we do not run and cannot test from here.
  const f = readCtazStatusFile(write("trunc.json", '{"readable":true,"at":123,"syncPer'));
  assert.equal(f.readable, false);
  assert.equal(f.at, null, "a file that would not parse has no usable timestamp");
});

test("readable must be EXPLICITLY true, so a file omitting it does not vouch for the node", () => {
  const f = readCtazStatusFile(write("noflag.json", JSON.stringify({ at: NOW, syncPercent: 42 })));
  assert.equal(f.readable, false, "absent is not true");
  // The percent still parses. It is a separate fact and the writer may know one and not
  // the other, which is exactly why they are separate fields.
  assert.equal(f.syncPercent, 42);
});

test("a non-numeric percent is null, never coerced", () => {
  // A writer bug that emitted a string must not become a number here. Coercing "100" to
  // 100 would hide the bug and coercing "unknown" to NaN would render as NaN on the page.
  for (const bad of ['"100"', "null", "true", '"unknown"']) {
    const f = readCtazStatusFile(write(`bad-${bad.replace(/\W/g, "")}.json`,
      `{"readable":true,"at":${NOW},"syncPercent":${bad}}`));
    assert.equal(f.syncPercent, null, `${bad} must not become a number`);
  }
});

/* ── Staleness, which is the property the timestamp exists for ──────────────────── */

test("A STALE FILE IS STALE, whatever it last said", () => {
  // The whole reason `at` is written. A file nobody is refreshing describes a node that
  // may have died ten minutes ago, and reporting its last known state as current is how a
  // green page outlives the thing it describes.
  const f = readCtazStatusFile(write("stale.json", JSON.stringify({
    readable: true, at: NOW - STATUS_STALE_AFTER_MS - 1_000, blocks: 1, tip: 1, syncPercent: 100,
  })));
  assert.equal(f.readable, true, "the file itself is fine");
  assert.equal(statusIsStale(f, NOW), true, "but it is too old to describe now");
});

test("a file with NO TIMESTAMP is stale, not fresh", () => {
  // Otherwise an unparseable or field-less file masquerades as current. We cannot date it,
  // and undatable is stale enough.
  assert.equal(statusIsStale(readCtazStatusFile(write("nots.json", '{"readable":true}')), NOW), true);
});

test("A FUTURE TIMESTAMP IS NOT FRESH", () => {
  // The box's clock and ours are different machines. A file stamped ahead of us produces a
  // negative age that passes every staleness test, so it would read as permanently current.
  // Same rule the miner heartbeat and the recency gate already follow.
  const f = readCtazStatusFile(write("future.json", JSON.stringify({ readable: true, at: NOW + 60_000 })));
  assert.equal(statusIsStale(f, NOW), true);
});

test("the staleness window has slack, or it flaps on ordinary jitter", () => {
  // The writer runs on a timer. One skipped run must not flip the panel to unknown, so the
  // window is several intervals rather than one.
  assert.ok(STATUS_STALE_AFTER_MS >= 120_000, "a window this tight would flap on a slow tick");
  const f = readCtazStatusFile(write("recent.json", JSON.stringify({ readable: true, at: NOW - 90_000 })));
  assert.equal(statusIsStale(f, NOW), false, "90s old is a skipped tick, not a dead writer");
});
