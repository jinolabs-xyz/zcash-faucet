/**
 * The parity checker, exercised rather than grepped.
 *
 * The repo suite can only read this file's TEXT - the harness image has no node - so a pin there
 * holds that a message exists, not that the logic behind it runs. Measured: deleting the
 * body-comparison and leaving its error string in place kept every repo check green. These run
 * the real script as a child process against fixtures and read its exit code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = "scripts/parity-check.mjs";

/** Run the checker in its own directory with the given fixtures; return {code, out}. */
function runParity({ spec, shipped, departures }) {
  const dir = mkdtempSync(join(tmpdir(), "parity-"));
  try {
    mkdirSync(join(dir, "design", "spec"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    writeFileSync(join(dir, "design", "spec", "spec.css"), spec);
    writeFileSync(join(dir, "src", "app", "shipped.css"), shipped);
    if (departures !== undefined) writeFileSync(join(dir, "design", "spec", "departures.json"), JSON.stringify(departures, null, 2));
    writeFileSync(join(dir, "scripts", "parity-check.mjs"), readFileSync(SCRIPT, "utf8"));
    try {
      const out = execFileSync(process.execPath, ["scripts/parity-check.mjs", "design/spec/spec.css", "src/app/shipped.css"], { cwd: dir, encoding: "utf8" });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const SPEC = ".a{color:red}\n.b{color:blue}\n";

test("identical CSS is parity", () => {
  const r = runParity({ spec: SPEC, shipped: SPEC, departures: {} });
  assert.equal(r.code, 0, r.out);
});

test("an undeclared change fails, and names the selector", () => {
  const r = runParity({ spec: SPEC, shipped: ".a{color:green}\n.b{color:blue}\n", departures: {} });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /UNDECLARED \(declarations differ\): \.a/);
});

test("declared with its body is parity", () => {
  const r = runParity({
    spec: SPEC, shipped: ".a{color:green}\n.b{color:blue}\n",
    departures: { ".a": { why: "a reason", shipped: "color:green" } },
  });
  assert.equal(r.code, 0, r.out);
});

test("A SECOND CHANGE CANNOT INHERIT AN EXISTING LABEL", () => {
  // The hole SDE-App predicted before this file existed: declared by selector alone, any later
  // change to that rule is covered by the old reason. Measured on the real sheet at the time:
  // adding an outline to an already-declared `.badge .dot` passed.
  const r = runParity({
    spec: SPEC, shipped: ".a{color:green;outline:9px solid red}\n.b{color:blue}\n",
    departures: { ".a": { why: "a reason", shipped: "color:green" } },
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /DECLARED WITH A DIFFERENT BODY: \.a/);
});

test("a declaration by selector alone is not enough", () => {
  const r = runParity({
    spec: SPEC, shipped: ".a{color:green}\n.b{color:blue}\n",
    departures: { ".a": "just a reason, no body" },
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a declaration must name what we ship/);
});

test("a declaration that no longer describes a divergence fails", () => {
  const r = runParity({ spec: SPEC, shipped: SPEC, departures: { ".a": { why: "stale", shipped: "color:green" } } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /STALE DEPARTURE/);
});

test("a rule moved into a media query is not parity", () => {
  const r = runParity({ spec: SPEC, shipped: ".b{color:blue}\n@media (min-width:1px){.a{color:red}}\n", departures: {} });
  assert.equal(r.code, 1, r.out);
});

test("a rule the spec has and we dropped is reported but not gated mid-transcription", () => {
  const r = runParity({ spec: SPEC, shipped: ".a{color:red}\n", departures: {} });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dropped 1/);
});
