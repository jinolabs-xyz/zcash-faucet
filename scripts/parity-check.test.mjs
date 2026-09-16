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
function runParity({ spec, shipped, departures, pages, shell, entry, args }) {
  const dir = mkdtempSync(join(tmpdir(), "parity-"));
  try {
    mkdirSync(join(dir, "design", "spec"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    // Optional page/shell sources, for the completion gate. Written only when a case asks,
    // so the eight cases above keep the tree they were measured against.
    if (pages) {
      for (const [route, src] of Object.entries(pages)) {
        mkdirSync(join(dir, "src", "app", route), { recursive: true });
        writeFileSync(join(dir, "src", "app", route, "page.tsx"), src);
      }
    }
    // src/app/page.tsx, for the imported-sheet discovery.
    if (entry !== undefined) writeFileSync(join(dir, "src", "app", "page.tsx"), entry);
    if (shell !== undefined) {
      mkdirSync(join(dir, "src", "components"), { recursive: true });
      writeFileSync(join(dir, "src", "components", "Shell.tsx"), shell);
    }
    writeFileSync(join(dir, "design", "spec", "spec.css"), spec);
    writeFileSync(join(dir, "src", "app", "shipped.css"), shipped);
    if (departures !== undefined) writeFileSync(join(dir, "design", "spec", "departures.json"), JSON.stringify(departures, null, 2));
    writeFileSync(join(dir, "scripts", "parity-check.mjs"), readFileSync(SCRIPT, "utf8"));
    try {
      const out = execFileSync(process.execPath, ["scripts/parity-check.mjs", "design/spec/spec.css", ...(args || ["src/app/shipped.css"])], { cwd: dir, encoding: "utf8" });
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

// THE COMPLETION GATE, WHICH COULD NEVER FINISH SWITCHING ON (SDE-UI, review of this PR).
// "In the shell" was one string in the page file, and the Shell extraction moved it: S5 puts a
// page in the shell by rendering <Shell>, and the shell owns the stage, so the page file
// contains `"stage"` zero times. Measured against S5's own branch, the old spelling reported
// 0 of 3 pages in the shell on exactly the tree it exists to detect, so the DROPPED class would
// have stayed advisory for ever. These two cases are the reason it is now two facts.
const SHELL_OWNING_STAGE = 'export function Shell(){ return <div className="stage" /> }\n';
const PAGE_RENDERING_SHELL = 'import { Shell } from "@/components/Shell";\nexport default function P(){ return <Shell>x</Shell> }\n';

test("a page is in the shell when it renders the Shell that owns the stage", () => {
  const r = runParity({
    spec: SPEC, shipped: SPEC,
    shell: SHELL_OWNING_STAGE,
    pages: { terms: PAGE_RENDERING_SHELL, donate: PAGE_RENDERING_SHELL, fund: PAGE_RENDERING_SHELL },
  });
  assert.match(r.out, /3\/3 pages in the shell/);
});

test("and a page that stops rendering it drops out of the count", () => {
  const r = runParity({
    spec: SPEC, shipped: SPEC,
    shell: SHELL_OWNING_STAGE,
    pages: { terms: 'export default function P(){ return <div>x</div> }\n', donate: PAGE_RENDERING_SHELL, fund: PAGE_RENDERING_SHELL },
  });
  assert.match(r.out, /2\/3 pages in the shell/);
});

test("the shell not owning the stage is not a shell, however many pages render it", () => {
  // The second fact, on its own. A <Shell> that carries no stage is a name, not the chrome,
  // and either fact alone is a string that can move again the way the first one did.
  const r = runParity({
    spec: SPEC, shipped: SPEC,
    shell: 'export function Shell(){ return <div className="something-else" /> }\n',
    pages: { terms: PAGE_RENDERING_SHELL, donate: PAGE_RENDERING_SHELL, fund: PAGE_RENDERING_SHELL },
  });
  assert.match(r.out, /0\/3 pages in the shell/);
});

// A WHOLE-RULE DELETION IS A DIVERGENCE (CTO red-team, review of this PR). CHANGED used to fire
// only when a shipped body was ABSENT from the spec's set, so a selector shipping a strict
// SUBSET read clean: every body it had was in the spec, and the selector was present so DROPPED
// missed it too. Deleting a rule from a shipped sheet - the likeliest way to lose a piece of the
// approved design - exited 0. Their mutant was `.strip .kv b{font-size:calc(.95*var(--u))}`.
test("a selector that ships FEWER bodies than the spec is a divergence", () => {
  const r = runParity({
    spec: ".a{color:red}\n.a{font-size:2px}\n",
    shipped: ".a{color:red}\n",
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /\.a/);
});

test("and the same bodies in both is still parity", () => {
  const r = runParity({
    spec: ".a{color:red}\n.a{font-size:2px}\n",
    shipped: ".a{color:red}\n.a{font-size:2px}\n",
  });
  assert.equal(r.code, 0);
});

// DECLARATION ORDER INSIDE A BODY IS PART OF THE BODY. Sorting made it a set and lost the one
// thing order is for in a rule: a fallback pair. Swapping these two changes which value an old
// browser ends up with, and it used to read as parity.
test("a reversed fallback pair is not parity", () => {
  const r = runParity({
    spec: ".a{display:-webkit-box; display:flex}\n",
    shipped: ".a{display:flex; display:-webkit-box}\n",
  });
  assert.equal(r.code, 1);
});

// A SHEET THE APP IMPORTS IS EITHER COMPARED OR DECLARED (CTO red-team). redesign-hero.css was
// not compared at all - the CI step named two sheets by hand and the app imported three - so
// eight divergences sat on main unseen. The list is discovered from the entry file now, and the
// gap, where a slice's spec has not been frozen, has to be written down rather than forgotten.
const ENTRY_TWO = 'import "./shipped.css";\nimport "./other.css";\n';

test("a sheet the app imports that is neither compared nor declared is a failure", () => {
  const r = runParity({ spec: SPEC, shipped: SPEC, entry: ENTRY_TWO });
  assert.equal(r.code, 1);
  assert.match(r.out, /src\/app\/other\.css/);
  assert.match(r.out, /neither compared nor declared/);
});

test("and declaring it _uncompared with a reason passes, and says so out loud", () => {
  const r = runParity({
    spec: SPEC, shipped: SPEC, entry: ENTRY_TWO,
    departures: { _uncompared: { "src/app/other.css": "its spec slice is not frozen yet" } },
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /other\.css is NOT compared - its spec slice is not frozen yet/);
});

test("a sheet declared _uncompared and ALSO compared is a contradiction", () => {
  const r = runParity({
    spec: SPEC, shipped: SPEC, entry: 'import "./shipped.css";\n',
    departures: { _uncompared: { "src/app/shipped.css": "stale" } },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /is declared "_uncompared" and is being compared/);
});

test("and an _uncompared entry the app no longer imports is stale", () => {
  const r = runParity({
    spec: SPEC, shipped: SPEC, entry: 'import "./shipped.css";\n',
    departures: { _uncompared: { "src/app/gone.css": "no longer imported" } },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /Stale declaration/);
});

