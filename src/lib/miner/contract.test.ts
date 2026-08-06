/**
 * THE OTHER HALF OF THE SEAM (#391).
 *
 * The miner heartbeat has a producer in Rust and a consumer in TypeScript, and until this
 * file nothing ran the pair. Each side was tested against fixtures a person wrote, which
 * is two guesses that can agree with each other while both differ from what the code does.
 *
 * Not hypothetical: zsnap-export shipped exactly that shape (#404). Its production check
 * and its test double were written to the same wrong belief about a hash, agreed with each
 * other perfectly, and rejected every real snapshot for two days while the suite was green.
 *
 * `deploy/z3/miner/testdata/heartbeat.canonical.json` is ONE artefact with two owners. A
 * Rust test asserts the real writer produces exactly those bytes; this asserts the real
 * reader parses that same file. Neither suite needs the other's toolchain, and a change on
 * either side that breaks the contract reds one of them.
 *
 * Read through readMinerHeartbeat rather than readingFor, because the filesystem hop is
 * part of what is being tested: this is the code path /api/status actually runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMinerHeartbeat } from "./read.ts";

const FIXTURE = fileURLToPath(
  new URL("../../../deploy/z3/miner/testdata/heartbeat.canonical.json", import.meta.url),
);

/** The fixture's writtenAt, so ages are deterministic rather than relative to the clock.
 *  It sits 8 seconds after lastTemplateAt, which is what makes the fixture a moment that
 *  could actually occur: the first version used an unrelated date and described a miner
 *  whose last template was ten days old, so this file failed for a reason that had nothing
 *  to do with the seam it exists to test. */
const WRITTEN_AT = Date.parse("2026-07-26T00:00:00Z");

test("the reader parses the writer's real bytes", () => {
  const r = readMinerHeartbeat(FIXTURE, WRITTEN_AT + 5_000);
  assert.equal(r.state, "running", `expected running, got ${r.state}`);
  assert.equal(r.beatAgoSeconds, 5);
  assert.equal(r.mode, "submit");
  assert.equal(r.lastTemplateHeight, 4237523);
  assert.equal(r.consecutiveErrors, 0);
  assert.equal(r.lastErrorStage, "template");
});

test("and the ages come out of the writer's own timestamps, not a guess", () => {
  // lastTemplateAt is 2026-07-25T23:59:52Z in the fixture. If the reader mis-parsed the
  // format the writer emits, this would be null or NaN rather than a number - which is
  // precisely the class of failure a hand-written fixture on each side cannot catch.
  const r = readMinerHeartbeat(FIXTURE, WRITTEN_AT);
  assert.equal(typeof r.templateAgoSeconds, "number");
  assert.ok(r.templateAgoSeconds! > 0, "a past template must have a positive age");
});

test("BOTH thresholds come from the writer, and the template one bites first", () => {
  // Written after getting it wrong. I assumed one threshold and asserted that 59s was
  // still running, because staleAfterSeconds is 60. It is not: the reader classifies on
  // the template age too, and templateStaleAfterSeconds is 48 against a template that is
  // already 8 seconds old in the fixture. So the first boundary is at +40s, not +59s.
  //
  // Both numbers come from the file rather than from a multiplier in the reader, which is
  // the property worth pinning - and neither boundary is where a person would guess.
  //
  //   +40s   templateAgo 48   at the template threshold, still running
  //   +41s   templateAgo 49   past it: STALLED, the miner is alive and fetching nothing
  //   +60s   beatAgo 60       at the beat threshold, still merely stalled
  //   +61s   beatAgo 61       past it: NOT-WRITING, the process itself has stopped
  assert.equal(readMinerHeartbeat(FIXTURE, WRITTEN_AT + 40_000).state, "running");
  assert.equal(readMinerHeartbeat(FIXTURE, WRITTEN_AT + 41_000).state, "stalled");
  assert.equal(readMinerHeartbeat(FIXTURE, WRITTEN_AT + 60_000).state, "stalled");
  assert.equal(readMinerHeartbeat(FIXTURE, WRITTEN_AT + 61_000).state, "not-writing");
});

/**
 * EVERY WRITER FIELD IS EITHER CONSUMED OR KNOWINGLY IGNORED.
 *
 * Not "the fields we read are read correctly" - that is what both sides already tested,
 * and it is what let box-report's `platform` and `minerBinary` be measured, shipped and
 * dropped for two days (#392).
 *
 * A new field in the Rust writer lands in neither list and reds this test, which forces
 * the decision to be made rather than defaulted. The ignore list is not an excuse: it is
 * a written record that someone looked at each one and said no.
 */
const CONSUMED = [
  "schema",
  "writtenAt",
  "staleAfterSeconds",
  "templateStaleAfterSeconds",
  "mode",
  "lastTemplateAt",
  "lastTemplateHeight",
  "lastErrorStage",
  "lastErrorAt",
  "consecutiveErrors",
  // Moved out of KNOWINGLY_IGNORED by #408. Writing that ignore list is what made these
  // visible: six fields the box measured and nobody read, four of them the only record
  // of whether this miner has ever won anything.
  "solvedCount",
  "lastSolvedAt",
  "submittedAccepted",
  "submittedRejected",
];

const KNOWINGLY_IGNORED: Record<string, string> = {
  // The writer publishes both the interval and the threshold it derives. The reader uses
  // the threshold on purpose, so it can never drift from the miner's configuration - the
  // interval is there for a human reading the file.
  beatSeconds: "superseded by staleAfterSeconds, which is the derived threshold",
  templateSeconds: "superseded by templateStaleAfterSeconds, for the same reason",
  // startedAt is the last one still unread. Kept deliberately: it would let the panel
  // separate "just started and has not fetched yet" from "up an hour and idle", and both
  // already render as stalled, so it changes the words rather than the verdict.
  startedAt: "would let the panel separate 'just started' from 'up an hour and idle'",
  lastSubmittedAt: "when it last submitted - not surfaced anywhere yet",
};

test("EVERY field the writer emits is accounted for, consumed or ignored on purpose", () => {
  const emitted = Object.keys(JSON.parse(readFileSync(FIXTURE, "utf8")));
  assert.ok(emitted.length > 10, `parsed ${emitted.length} fields, the fixture has rotted`);

  const unaccounted = emitted.filter(
    (k) => !CONSUMED.includes(k) && !(k in KNOWINGLY_IGNORED),
  );
  assert.deepEqual(
    unaccounted,
    [],
    `the Rust miner writes ${unaccounted.join(", ")} and this reader neither uses it nor ` +
      "records a decision to skip it. Add it to CONSUMED and to the Heartbeat interface, " +
      "or to KNOWINGLY_IGNORED with the reason.",
  );
});

test("and nothing is listed as consumed that the writer does not actually send", () => {
  // The mirror. Without it, CONSUMED could name a field that was renamed on the Rust side
  // and the test above would still pass, because it only walks the writer's keys.
  const emitted = new Set(Object.keys(JSON.parse(readFileSync(FIXTURE, "utf8"))));
  const phantom = [...CONSUMED, ...Object.keys(KNOWINGLY_IGNORED)].filter((k) => !emitted.has(k));
  assert.deepEqual(phantom, [], `named here but not written by the miner: ${phantom.join(", ")}`);
});

test("a schema bump is refused, because an unknown format is not a working miner", () => {
  const bumped = { ...JSON.parse(readFileSync(FIXTURE, "utf8")), schema: 2 };
  const tmp = fileURLToPath(new URL("./.contract-schema2.json", import.meta.url));
  writeFileSync(tmp, JSON.stringify(bumped));
  try {
    assert.equal(readMinerHeartbeat(tmp, WRITTEN_AT).state, "cannot-verify");
  } finally {
    rmSync(tmp, { force: true });
  }
});
