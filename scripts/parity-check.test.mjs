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
function runParity({ spec, shipped, departures, pages, shell, entry, args, sheets, specs, env }) {
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
    for (const [name, body] of Object.entries(sheets || {})) writeFileSync(join(dir, "src", "app", name), body);
    for (const [name, body] of Object.entries(specs || {})) writeFileSync(join(dir, "design", "spec", name), body);
    if (shell !== undefined) {
      mkdirSync(join(dir, "src", "components"), { recursive: true });
      writeFileSync(join(dir, "src", "components", "Shell.tsx"), shell);
    }
    writeFileSync(join(dir, "design", "spec", "spec.css"), spec);
    writeFileSync(join(dir, "src", "app", "shipped.css"), shipped);
    if (departures !== undefined) writeFileSync(join(dir, "design", "spec", "departures.json"), JSON.stringify(departures, null, 2));
    writeFileSync(join(dir, "scripts", "parity-check.mjs"), readFileSync(SCRIPT, "utf8"));
    try {
      const out = execFileSync(process.execPath, ["scripts/parity-check.mjs", "design/spec/spec.css", ...(args || ["src/app/shipped.css"])], { cwd: dir, encoding: "utf8", env: { ...process.env, ...(env || {}) } });
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
    departures: { ".a": { kind: "divergence", why: "a reason", shipped: "color:green" } },
  });
  assert.equal(r.code, 0, r.out);
});

test("A SECOND CHANGE CANNOT INHERIT AN EXISTING LABEL", () => {
  // The hole SDE-App predicted before this file existed: declared by selector alone, any later
  // change to that rule is covered by the old reason. Measured on the real sheet at the time:
  // adding an outline to an already-declared `.badge .dot` passed.
  const r = runParity({
    spec: SPEC, shipped: ".a{color:green;outline:9px solid red}\n.b{color:blue}\n",
    departures: { ".a": { kind: "divergence", why: "a reason", shipped: "color:green" } },
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
  const r = runParity({ spec: SPEC, shipped: SPEC, departures: { ".a": { kind: "divergence", why: "stale", shipped: "color:green" } } });
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

// EVERY IMPORTED SHEET NAMES ITS OWN SPEC (CTO ruling on the red-team's finding 3).
// `_uncompared` was my first answer and was refused: a sheet imported and not compared is the
// hole this check exists to close, and labelling the hole makes the green mean less. So each
// sheet declares `@spec <path>` on its first line and is compared against that document.
const ENTRY_TWO = 'import "./shipped.css";\nimport "./other.css";\n';
const DECL = (p) => `/* @spec ${p} */\n`;

test("an imported sheet that declares no spec is a failure", () => {
  const r = runParity({
    spec: SPEC, shipped: SPEC, entry: ENTRY_TWO,
    sheets: { "other.css": ".b{color:red}\n" },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /(does|do) not declare a spec/);
});

test("and a declaration naming a spec that is not vendored is a failure", () => {
  const r = runParity({
    spec: SPEC, shipped: DECL("design/spec/spec.css") + SPEC, entry: ENTRY_TWO,
    sheets: { "other.css": DECL("design/spec/nope.css") + ".b{color:red}\n" },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /which is not vendored/);
});

test("and a sheet compared against a spec it does not declare is a failure", () => {
  const r = runParity({
    spec: SPEC, shipped: DECL("design/spec/other-slice.css") + SPEC, entry: 'import "./shipped.css";\n',
    specs: { "other-slice.css": SPEC },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /but is being compared against/);
});

test("and a sheet declaring the spec it is compared against passes", () => {
  const r = runParity({
    spec: SPEC, shipped: DECL("design/spec/spec.css") + SPEC, entry: 'import "./shipped.css";\n',
  });
  assert.equal(r.code, 0);
});

// THE GATE'S ON DIRECTION HAD NO TEST (CTO red-team). Everything above drives the gate while it
// is OFF: `transcriptionComplete` hardcoded false stayed 11/11 and repo 213/0, and `divergent`
// never including `dropped` stayed 11/11 too. A gate whose whole purpose is to start enforcing
// DROPPED at the end of the transcription had no case in which it enforced anything - which is
// the same defect as an assertion that cannot fail, aimed at the half nobody was looking at.
const ALL_VIEWS = ["claim", "status", "analytics", "tools"]
  .map((v) => `<section data-view="${v}">x</section>`).join("\n");
const SHELL_SRC = 'export function Shell(){ return <div className="stage" /> }\n';
const PAGE_IN_SHELL = 'import { Shell } from "@/components/Shell";\nexport default function P(){ return <Shell>x</Shell> }\n';
const ALL_PAGES = { terms: PAGE_IN_SHELL, donate: PAGE_IN_SHELL, fund: PAGE_IN_SHELL };
// The spec has a rule we do not ship: DROPPED, and only gated once everything has landed.
const SPEC_WITH_EXTRA = ".a{color:red}\n.gone{color:blue}\n";

test("with everything wired, a DROPPED rule is a divergence and fails", () => {
  const r = runParity({
    spec: SPEC_WITH_EXTRA, shipped: ".a{color:red}\n",
    entry: ALL_VIEWS, shell: SHELL_SRC, pages: ALL_PAGES,
  });
  assert.match(r.out, /the transcription is complete, so DROPPED is gated too/);
  assert.equal(r.code, 1);
  assert.match(r.out, /\.gone/);
});

test("and the same tree with one view unwired leaves DROPPED ungated", () => {
  const threeViews = ["claim", "status", "analytics"]
    .map((v) => `<section data-view="${v}">x</section>`).join("\n");
  const r = runParity({
    spec: SPEC_WITH_EXTRA, shipped: ".a{color:red}\n",
    entry: threeViews, shell: SHELL_SRC, pages: ALL_PAGES,
  });
  assert.match(r.out, /3\/4 views wired/);
  assert.equal(r.code, 0);
});

test("and with one page out of the shell, likewise", () => {
  const r = runParity({
    spec: SPEC_WITH_EXTRA, shipped: ".a{color:red}\n",
    entry: ALL_VIEWS, shell: SHELL_SRC,
    pages: { ...ALL_PAGES, fund: "export default function P(){ return <div>x</div> }\n" },
  });
  assert.match(r.out, /2\/3 pages in the shell/);
  assert.equal(r.code, 0);
});

// AND THE VIEW READER ITSELF, which had no fixture at all: a view still carrying
// `legacy-measure` is NOT wired, which is the distinction the reader exists to make. The real
// markup puts the class and the attribute on ONE element - `<section className="view
// legacy-measure" data-view="status">` - and that is the shape asserted here.
//
// My first version of this fixture NESTED a view section inside a legacy-measure section and it
// reported 4 of 4. That is true of the reader - it scans back to the nearest `<section` and a
// nested one hides the outer class - but it is not a shape the app produces, so asserting it
// would have been testing an invented page. Left as a note instead: the guard is positional,
// and wrapping the views in a legacy container would defeat it silently.
test("a view still marked legacy-measure does not count as wired", () => {
  const legacy = '<section class="view legacy-measure" data-view="tools">x</section>\n'
    + ["claim", "status", "analytics"].map((v) => `<section data-view="${v}">x</section>`).join("\n");
  const r = runParity({
    spec: SPEC_WITH_EXTRA, shipped: ".a{color:red}\n",
    entry: legacy, shell: SHELL_SRC, pages: ALL_PAGES,
  });
  assert.match(r.out, /3\/4 views wired/);
});

// A SLICE GATES ON ITS OWN FACTS, AND THEY ARE ANDed. A spec block is a whole page, so one
// slice's spec carries rules belonging to a slice that has not shipped; gating DROPPED on
// another slice's completeness turns main red for work nobody has done yet.
//
// NEITHER FACT IS "THE FILE EXISTS" (SDE-App, who warned me off the obvious answer): the card
// sheet is committed INERT on their branch, imported by nothing, so presence is true while the
// slice is not live. The facts are that the page imports it and that the markup it styles
// renders - the same shape as page-renders-Shell AND Shell-owns-the-stage.
const SLICE = (facts) => ({
  _slice: { why: "the card slice has not shipped", facts },
});
const F_IMPORT = { file: "src/app/page.tsx", contains: "./card.css" };
const F_MARKUP = { file: "src/app/page.tsx", contains: "data-phase" };

test("with none of the slice's facts, DROPPED is not gated", () => {
  const r = runParity({
    spec: SPEC_WITH_EXTRA, shipped: ".a{color:red}\n",
    entry: "export default function P(){ return <div/> }\n",
    departures: SLICE([F_IMPORT, F_MARKUP]),
  });
  assert.match(r.out, /slice gate: 0\/2 facts hold/);
  assert.equal(r.code, 0);
});

test("with only ONE of them, still not gated - they are ANDed", () => {
  const r = runParity({
    spec: SPEC_WITH_EXTRA, shipped: ".a{color:red}\n",
    entry: 'import "./card.css";\nexport default function P(){ return <div/> }\n',
    // card.css is PASSED as well as imported: a sheet the app imports and CI does not compare
    // is the hole the coverage gate now closes, so a fixture may not model it. Its body is
    // empty so the rule counts these two cases assert on are exactly what they were.
    sheets: { "card.css": DECL("design/spec/spec.css") },
    args: ["src/app/shipped.css", "src/app/card.css"],
    departures: SLICE([F_IMPORT, F_MARKUP]),
  });
  assert.match(r.out, /slice gate: 1\/2 facts hold/);
  assert.equal(r.code, 0);
});

test("and with both, DROPPED is enforced for that spec", () => {
  const r = runParity({
    spec: SPEC_WITH_EXTRA, shipped: ".a{color:red}\n",
    entry: 'import "./card.css";\nexport default function P(){ return <div data-phase="ready"/> }\n',
    // card.css is PASSED as well as imported: a sheet the app imports and CI does not compare
    // is the hole the coverage gate now closes, so a fixture may not model it. Its body is
    // empty so the rule counts these two cases assert on are exactly what they were.
    sheets: { "card.css": DECL("design/spec/spec.css") },
    args: ["src/app/shipped.css", "src/app/card.css"],
    departures: SLICE([F_IMPORT, F_MARKUP]),
  });
  assert.match(r.out, /slice gate: 2\/2 facts hold/);
  assert.equal(r.code, 1);
  assert.match(r.out, /\.gone/);
});

// AND THE FILE MERELY EXISTING IS NOT ONE OF THE FACTS, which is the trap: a fact keyed on the
// sheet being in the directory is TRUE while the slice is inert.
test("a fact keyed on the sheet existing would arm early, so it is not what is declared", () => {
  const r = runParity({
    spec: SPEC_WITH_EXTRA, shipped: ".a{color:red}\n",
    entry: "export default function P(){ return <div/> }\n",
    sheets: { "card.css": ".x{color:red}\n" },
    departures: SLICE([F_IMPORT, F_MARKUP]),
  });
  assert.match(r.out, /slice gate: 0\/2 facts hold/);
  assert.equal(r.code, 0);
});


// ---------------------------------------------------------------------------------------
// SHEET DISCOVERY, which was a hand-written list of two entry files and is now a walk.
// Measured on #576's branch before this change: every redesign import moves out of
// `src/app/page.tsx` into `src/components/Shell.tsx` and is spelled `@/app/...`, both CI
// invocations exit 0, and `redesign-subpages.css` is never compared. These fix that shape in
// place so it cannot come back quietly.

const SPEC_DECL_LINE = DECL("design/spec/spec.css");

test("a sheet imported from a component, by alias, is discovered and must be compared", () => {
  const r = runParity({
    spec: SPEC,
    shipped: SPEC_DECL_LINE + SPEC,
    departures: {},
    entry: 'import "./shipped.css";\n',
    shell: 'import "@/app/elsewhere.css";\n',
    sheets: { "elsewhere.css": SPEC_DECL_LINE + SPEC },
    args: ["src/app/shipped.css"],
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/app\/elsewhere\.css/);
  assert.match(r.out, /not one of its rules is compared/);
});

test("and passing it satisfies the gate, so the failure above is about coverage and not the sheet", () => {
  const r = runParity({
    spec: SPEC,
    shipped: SPEC_DECL_LINE + SPEC,
    departures: {},
    entry: 'import "./shipped.css";\n',
    shell: 'import "@/app/elsewhere.css";\n',
    sheets: { "elsewhere.css": SPEC_DECL_LINE + SPEC },
    args: ["src/app/shipped.css", "src/app/elsewhere.css"],
  });
  assert.equal(r.code, 0, r.out);
});

test("a relative import from a nested component resolves to the sheet it names", () => {
  const r = runParity({
    spec: SPEC,
    shipped: SPEC_DECL_LINE + SPEC,
    departures: {},
    entry: 'import "./shipped.css";\n',
    shell: 'import "../app/elsewhere.css";\n',
    sheets: { "elsewhere.css": SPEC_DECL_LINE + SPEC },
    args: ["src/app/shipped.css"],
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/app\/elsewhere\.css/);
});

test("sources that import no CSS at all are a broken walk, not an empty answer", () => {
  const r = runParity({
    spec: SPEC,
    shipped: SPEC_DECL_LINE + SPEC,
    departures: {},
    entry: "export default function P() { return null; }\n",
    shell: "export function Shell() { return null; }\n",
    sheets: { "globals.css": "body{margin:0}\n" },
    args: ["src/app/shipped.css"],
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /[Ss]heet discovery is broken/);
});

// AND ONE THAT SEPARATES THE TWO HALVES. The two cases above need BOTH the walk (to see the
// sheet) and the coverage gate (to object), so either half being reverted kills both of them
// and neither says which broke. This one exercises the walk ALONE: an undeclared sheet is
// caught by a gate that predates this change, so it fails when discovery regresses and passes
// when only the coverage gate is removed.
test("the walk alone is what finds a component-imported sheet, declared or not", () => {
  const r = runParity({
    spec: SPEC,
    shipped: SPEC_DECL_LINE + SPEC,
    departures: {},
    entry: 'import "./shipped.css";\n',
    shell: 'import "@/app/elsewhere.css";\n',
    sheets: { "elsewhere.css": SPEC },     // no @spec line
    args: ["src/app/shipped.css"],
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/app\/elsewhere\.css does not declare a spec/);
});

// ---------------------------------------------------------------------------------------
// TWO KINDS OF DEPARTURE. A file that means both means neither: "twelve departures" says
// nothing about whether the design is being ignored or protected. CTO ruling after SDE-UI
// found the case on #576 - the design's own copy control is under the tap-target floor, so a
// faithful transcription broke a rule that lives outside the spec.

const DIVERGE = { kind: "divergence", why: "x", shipped: "color:green" };

test("a declaration that does not say which kind it is fails, and is named", () => {
  const r = runParity({
    spec: SPEC, shipped: ".a{color:green}\n.b{color:blue}\n",
    departures: { ".a": { why: "x", shipped: "color:green" } },
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /UNKINDED DECLARATION: \.a/);
  assert.match(r.out, /means both means neither/);
});

test("and a kind that is not one of the two is refused rather than accepted as a label", () => {
  const r = runParity({
    spec: SPEC, shipped: ".a{color:green}\n.b{color:blue}\n",
    departures: { ".a": { kind: "wontfix", why: "x", shipped: "color:green" } },
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /"wontfix"/);
});

test("the two kinds are counted apart, so one number can be driven down and the other left alone", () => {
  const r = runParity({
    spec: ".a{color:red}\n.b{color:blue}\n.c{color:pink}\n",
    shipped: ".a{color:green}\n.b{color:blue}\n.c{color:teal}\n",
    departures: {
      ".a": DIVERGE,
      ".c": { kind: "override", why: "a floor the design cannot satisfy", shipped: "color:teal" },
    },
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 divergence\(s\) from the design, 1 override\(s\) of it/);
});

test("PARITY_PRINT emits the kind field, so the generator cannot reintroduce unkinded entries", () => {
  const r = runParity({
    spec: SPEC, shipped: ".a{color:green}\n.b{color:blue}\n",
    departures: {}, env: { PARITY_PRINT: "1" },
  });
  assert.match(r.out, /"kind"/);
  assert.match(r.out, /divergence \| override/);
});

test("a spec held by its slice gate says so, instead of claiming mid-transcription at 4/4 and 3/3", () => {
  const r = runParity({
    spec: SPEC_WITH_EXTRA, shipped: ".a{color:red}\n",
    entry: ALL_VIEWS, shell: SHELL_SRC, pages: ALL_PAGES,
    sheets: { "card.css": DECL("design/spec/spec.css") },
    args: ["src/app/shipped.css", "src/app/card.css"],
    departures: SLICE([F_IMPORT, F_MARKUP]),
  });
  // everything the views/pages tally looks at is wired, and the slice gate is what still holds it
  assert.match(r.out, /held by the slice gate, not by the views/);
  assert.match(r.out, /which this spec does not consult/);
  assert.doesNotMatch(r.out, /mid-transcription/);
  assert.equal(r.code, 0, r.out);
});

// ---------------------------------------------------------------------------------------
// A SELECTOR SPLIT ACROSS TWO RULES IS THE SAME CSS AS ONE MERGED RULE.

test("a selector the spec splits across two rules, merged in the shipped sheet, is parity", () => {
  const r = runParity({
    spec: ".a{color:red}\n.a{font-weight:600}\n.b{color:blue}\n",
    shipped: ".a{color:red;font-weight:600}\n.b{color:blue}\n",
    departures: {},
  });
  assert.equal(r.code, 0, r.out);
});

test("and the other direction, split in the shipped sheet and merged in the spec", () => {
  const r = runParity({
    spec: ".a{color:red;font-weight:600}\n.b{color:blue}\n",
    shipped: ".a{color:red}\n.a{font-weight:600}\n.b{color:blue}\n",
    departures: {},
  });
  assert.equal(r.code, 0, r.out);
});

test("a merge that is not the same declarations is still a divergence", () => {
  const r = runParity({
    spec: ".a{color:red}\n.a{font-weight:600}\n.b{color:blue}\n",
    shipped: ".a{color:red;font-weight:700}\n.b{color:blue}\n",
    departures: {},
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /UNDECLARED/);
});

test("THE FALLBACK PATTERN IS UNTOUCHED: one property declared twice keeps its order", () => {
  // `color` twice is a deliberate old-browser fallback - the LAST one an old browser
  // understands wins, so swapping them changes what ships. A declaration set would call
  // these equal, which is why the body-level comparison still stands where a property repeats.
  const r = runParity({
    spec: ".a{color:red;color:color-mix(in srgb,red,blue)}\n.b{color:blue}\n",
    shipped: ".a{color:color-mix(in srgb,red,blue);color:red}\n.b{color:blue}\n",
    departures: {},
  });
  assert.equal(r.code, 1, r.out);
});

// THE CASE THE CTO NAMED, which is the real one from S2's spec: the same selector twice at the
// same specificity, so the later rule's font-size kills the earlier clamp IN THE PREVIEW. A
// shipped sheet carrying only the winner is what the browser applies; carrying the dead clamp
// is what #567 round one did, and it rendered 23.04px where the preview rendered 25.2.
const CLAMP = "font-size:clamp(calc(1.2*var(--u)),1.6vw,calc(1.8*var(--u)))";
const FIXED = "font-size:calc(1.8*var(--u));color:var(--display-accent)";

test("a spec declaration killed by a later rule for the same selector is not required of the sheet", () => {
  const r = runParity({
    spec: `.big b{${CLAMP}}\n.big b{${FIXED}}\n.b{color:blue}\n`,
    shipped: `.big b{${FIXED}}\n.b{color:blue}\n`,
    departures: {},
  });
  assert.equal(r.code, 0, r.out);
});

test("and the reverse is still a divergence: shipping the clamp where the spec's winner is fixed", () => {
  const r = runParity({
    spec: `.big b{${FIXED}}\n.b{color:blue}\n`,
    shipped: `.big b{${CLAMP}}\n.b{color:blue}\n`,
    departures: {},
  });
  assert.equal(r.code, 1, r.out);
});

test("a later rule killing a property does not hide a DIFFERENT property it also sets", () => {
  const r = runParity({
    spec: `.big b{font-size:1px;color:red}\n.big b{font-size:2px}\n.b{color:blue}\n`,
    shipped: `.big b{font-size:2px}\n.b{color:blue}\n`,   // colour dropped
    departures: {},
  });
  assert.equal(r.code, 1, r.out);
});
