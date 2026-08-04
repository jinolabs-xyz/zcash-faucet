/**
 * THE READER MUST LOSE NOTHING THE WRITER SENDS.
 *
 * Everything else here is a normal parse test. This file exists for the first one,
 * which compares the SET of keys `box-report.sh` emits against the set
 * `readBoxIntegrity` returns.
 *
 * That distinction is the whole of #392. We already tested that the fields we read are
 * read correctly, and that test passed the entire time `platform` and `minerBinary`
 * were being measured on the box, serialised, shipped through a volume, and dropped one
 * line before they became visible. A test that checks only what the consumer already
 * consumes cannot ever notice a field the consumer forgot - it is two guesses agreeing.
 *
 * So the assertion is stated negatively and about sets: no key in the writer's output is
 * absent from the reader's. It fails when someone adds a field to the shell script and
 * not to this file, which is exactly how the last three of these happened (#352, #388,
 * #392).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "box-report-"));
const reportPath = join(dir, "box-integrity.json");

// FAUCET_BOX_REPORT_PATH is read at module load, so it has to be set before the import
// below. A plain top-level `import` would be hoisted above this line and resolve the
// path to the repo's data dir, and the tests would silently read whatever is there.
process.env.FAUCET_BOX_REPORT_PATH = reportPath;
const { readBoxIntegrity } = await import("./boxIntegrityFile.ts");

const write = (o: unknown) => writeFileSync(reportPath, JSON.stringify(o));

/**
 * The exact JSON `box-report.sh` writes on its success path, kept in the shape the
 * shell emits it. Copied from the `write "{...}"` line at the bottom of that script.
 *
 * A fixture, and therefore a guess - but the test below turns it into a checkable one:
 * it also asserts this list matches the field names actually present in the script, so
 * a field added there and not here reds this file rather than passing quietly.
 */
const WRITER_FIELDS = {
  expected: 41,
  present: 41,
  notEnabled: 0,
  enabledUndeclared: 4,
  minerBinary: "current",
  platform: "x86_64",
  watchdogRestarts: 0,
  watchdogRestartsDelta: 0,
  at: 1_700_000_000_000,
  readable: true,
};

test("THE READER LOSES NOTHING: every field the writer emits arrives", () => {
  write(WRITER_FIELDS);
  const r = readBoxIntegrity();
  assert.ok(r, "the report should parse");

  const sent = new Set(Object.keys(WRITER_FIELDS));
  const arrived = new Set(Object.keys(r));
  const dropped = [...sent].filter((k) => !arrived.has(k));

  assert.deepEqual(
    dropped,
    [],
    `the box measured these and the reader threw them away: ${dropped.join(", ")}. ` +
      "Add them to IntegrityReport and to readBoxIntegrity, or stop writing them.",
  );
});

test("and the fixture above is the REAL writer's field list, not a wish", () => {
  // Without this, the set comparison is two guesses agreeing again: I could drop a
  // field from WRITER_FIELDS and the test above would go green while the box kept
  // sending it. So the fixture is checked against the shell script itself.
  const script = readFileSync(
    new URL("../../deploy/z3/box-report.sh", import.meta.url),
    "utf8",
  );
  const line = script.split("\n").find((l) => l.includes('write "{') && l.includes('\\"expected\\"'));
  assert.ok(line, "could not find box-report.sh's write line, so this check proved nothing");

  const emitted = [...line.matchAll(/\\"([a-zA-Z]+)\\":/g)].map((m) => m[1]);
  assert.ok(emitted.length > 5, `parsed only ${emitted.length} field names, the regex has rotted`);

  const missingFromFixture = emitted.filter((k) => !(k in WRITER_FIELDS));
  assert.deepEqual(
    missingFromFixture,
    [],
    `box-report.sh emits ${missingFromFixture.join(", ")}, which this file's fixture does not list`,
  );
});

test("platform and minerBinary arrive with their values, not merely their keys", () => {
  write(WRITER_FIELDS);
  const r = readBoxIntegrity();
  assert.equal(r?.platform, "x86_64");
  assert.equal(r?.minerBinary, "current");
});

test("a report predating the fields is null there, never a guess", () => {
  const old: Record<string, unknown> = { ...WRITER_FIELDS };
  delete old.platform;
  delete old.minerBinary;
  write(old);
  const r = readBoxIntegrity();
  assert.equal(r?.platform, null);
  assert.equal(r?.minerBinary, null);
  assert.equal(r?.expected, 41, "the rest of the report still parses");
});

test("an empty string is not a value", () => {
  // box-report defaults platform to the literal "unknown" when uname says nothing, so
  // an empty string means damage in transit. Rendering "" would look like a blank cell
  // in a table of measurements rather than an absence.
  write({ ...WRITER_FIELDS, platform: "", minerBinary: "" });
  const r = readBoxIntegrity();
  assert.equal(r?.platform, null);
  assert.equal(r?.minerBinary, null);
});

test("a wrong type is not coerced", () => {
  write({ ...WRITER_FIELDS, platform: 42, minerBinary: ["current"] });
  const r = readBoxIntegrity();
  assert.equal(r?.platform, null);
  assert.equal(r?.minerBinary, null);
});

test("readable:false still answers on every field, so the shape never varies", () => {
  write({ readable: false });
  const r = readBoxIntegrity();
  assert.equal(r?.readable, false);
  assert.ok(r && "platform" in r && "minerBinary" in r, "the unreadable branch must carry the same keys");
  assert.equal(r?.platform, null);
});

test("unparseable is null, not a partial report", () => {
  writeFileSync(reportPath, "{ this is not json");
  assert.equal(readBoxIntegrity(), null);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
