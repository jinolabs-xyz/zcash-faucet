/**
 * Rule-level parity between the CSS we ship and the CSS the owner approved.
 *
 * Text against text, no browser, milliseconds. It is what found `.brand .name` 4% too large and
 * `.view.hero` carrying a viewport calc the design does not have, both of which had survived a
 * transcription that everyone believed was faithful.
 *
 * THE SPEC IS A VENDORED COPY OF A FROZEN SNAPSHOT, never the live share directory: the preview
 * moved three times during one slice, and a check that compares against a moving thing reports
 * whatever the last edit did. design/spec/<snapshot>/shell.css is a golden file, and the diff
 * that updates it is the diff a reviewer reads.
 *
 * THREE CLASSES, because two of them are easy to miss:
 *   - ADDED     a selector we ship that the spec does not have
 *   - CHANGED   a selector both have, with different declarations
 *   - DROPPED   a selector the spec has that we do not ship at all
 * The third is the one an ad-hoc diff forgets, and it is how a rule quietly stops applying.
 *
 * DEPARTURES ARE DECLARED WITH THEIR REASON, in design/spec/departures.json, and a departure that
 * is no longer a departure FAILS. An allowlist nobody prunes becomes a list of things the check
 * has stopped looking at.
 */
import { readFileSync, existsSync } from "node:fs";

const SPEC = process.argv[2];
const SHIPPED = process.argv.slice(3);
if (!SPEC || SHIPPED.length === 0) {
  console.error("usage: node scripts/parity-check.mjs <spec.css> <shipped.css...>");
  process.exit(2);
}
const DEPARTURES = "design/spec/departures.json";

// THE AT-RULE IS PART OF THE KEY, because a rule that MOVED into a breakpoint is not the same
// rule. A flat regex over `selector{...}` compares `.seg button` inside `@media (max-width:32rem)`
// with `.seg button` at top level and calls them equal - so shifting a declaration into a
// media query would read as parity, which is L1 in this file's own terms: the check would be
// measuring text that resembles the property rather than the property. Brace-matched walk, with
// the enclosing at-rule preludes carried into the key.
const rules = (css) => {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map();
  const norm = (t) => t.trim().replace(/\s+/g, " ").replace(/["']/g, "");
  const walk = (text, context) => {
    let i = 0, start = 0, depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "{") {
        if (depth === 0) var preludeEnd = i;
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          const prelude = norm(text.slice(start, preludeEnd));
          const body = text.slice(preludeEnd + 1, i);
          if (prelude.startsWith("@")) {
            // A nested block: its children are keyed under this prelude.
            if (/^@(media|supports|container|layer)/.test(prelude)) walk(body, context ? `${context} && ${prelude}` : prelude);
            // @keyframes and friends are compared whole, since their inner blocks are frames.
            else addRule(out, context ? `${context} && ${prelude}` : prelude, norm(body));
          } else {
            addRule(out, context ? `${context} | ${prelude}` : prelude, body.split(";").map((d) => d.trim()).filter(Boolean).sort().join("; "));
          }
          start = i + 1;
        }
      }
      i += 1;
    }
  };
  walk(css, "");
  return out;
};
const addRule = (out, key, body) => {
  if (!out.has(key)) out.set(key, new Set());
  out.get(key).add(body);
};

// NOT APPLICABLE IS A STATE, AND IT IS SAID OUT LOUD. Before S1 lands there is no redesign CSS
// to compare and this would otherwise pass with nothing to say, which is the shape of a check
// that reports success without verifying anything. The shipped files are named on the command
// line, so their absence is the signal.
const missing = SHIPPED.filter((f) => !existsSync(f));
if (missing.length === SHIPPED.length) {
  console.log(`parity-check: none of ${SHIPPED.join(", ")} is in this tree, so the redesign has not landed yet. NOT APPLICABLE, not passed.`);
  process.exit(0);
}
if (missing.length) {
  console.error(`parity-check: ${missing.join(", ")} missing while ${SHIPPED.filter((f) => existsSync(f)).join(", ")} is present - a half-landed shell is not something this can judge`);
  process.exit(1);
}

const specCss = readFileSync(SPEC, "utf8");
const shipCss = SHIPPED.map((f) => readFileSync(f, "utf8")).join("\n");
const spec = rules(specCss);
const ship = rules(shipCss);

// Keys beginning with `_` are notes to the reader, not declarations. Without this the file's own
// header comment was reported as a stale departure, which my own stale check caught on its first
// run - the check working, and a reminder that a data file with prose in it needs a convention.
const declared = Object.fromEntries(
  Object.entries(existsSync(DEPARTURES) ? JSON.parse(readFileSync(DEPARTURES, "utf8")) : {})
    .filter(([k]) => !k.startsWith("_")),
);
const added = [...ship.keys()].filter((s) => !spec.has(s));
const changed = [...ship.keys()].filter((s) => spec.has(s) && [...ship.get(s)].some((b) => !spec.get(s).has(b)));
const dropped = [...spec.keys()].filter((s) => !ship.has(s));

// DROPPED IS NOT A FAULT UNTIL THE TRANSCRIPTION IS FINISHED, and pretending otherwise makes
// this unusable: against S1 the spec has 255 rules and the shell ships 84, so 177 "dropped"
// would bury the six that matter. The design arrives slice by slice, so a rule the spec has and
// we do not is only a defect once every slice has landed.
//
// WHICH IS A FACT IN THE TREE, not a flag someone remembers to flip: the transcription is
// complete when every view is wired and every page is in the shell - the same facts the fit
// check reads. Until then dropped rules are counted and listed under a heading that says they
// are expected, and ADDED and CHANGED are gated from the first slice, because those two mean we
// ship something the approved design does not say.
const PAGE_SRC = "src/app/page.tsx";
const wiredViews = existsSync(PAGE_SRC) ? ["claim", "status", "analytics", "tools"].filter((v) => {
  const src = readFileSync(PAGE_SRC, "utf8");
  const i = src.indexOf(`data-view="${v}"`);
  return i !== -1 && !src.slice(src.lastIndexOf("<section", i), i).includes("legacy-measure");
}) : [];
const pagesInShell = ["/terms", "/donate", "/fund"].filter((r) => {
  const f = `src/app${r}/page.tsx`;
  return existsSync(f) && readFileSync(f, "utf8").includes('"stage"');
});
const transcriptionComplete = wiredViews.length === 4 && pagesInShell.length === 3;

const divergent = new Set(transcriptionComplete ? [...added, ...changed, ...dropped] : [...added, ...changed]);

// A DECLARATION NAMES WHAT WE SHIP, NOT JUST THE SELECTOR (SDE-App predicted this before the
// file existed: "a departures file is a place to hide a real divergence"). Declared per selector
// alone, a SECOND, different change to an already-declared rule inherits the old label silently -
// measured: adding `outline:9px solid red` to `.badge .dot`, which is declared, passed. So each
// entry carries the declarations we ship for that selector, and a body that is not the declared
// one is an undeclared divergence even though the selector is listed.
const shippedBody = (sel) => [...(ship.get(sel) || [])].sort().join(" || ");
const bodyOf = (entry) => (typeof entry === "string" ? null : entry && entry.shipped);
const reasonOf = (entry) => (typeof entry === "string" ? entry : entry && entry.why) || "";
const wrongBody = [...divergent].filter((s) => {
  const e = declared[s];
  if (e === undefined) return false;               // undeclared, reported below
  const want = bodyOf(e);
  if (want === null) return true;                  // declared by selector only: not enough
  return want !== shippedBody(s);
});
const undeclared = [...divergent].filter((s) => !(s in declared));
const stale = Object.keys(declared).filter((s) => !divergent.has(s));

if (process.env.PARITY_PRINT === "1") {
  // Prints the exact entries for the current divergences, so a declaration is copied rather
  // than retyped - a hand-typed body would be one more thing that can be subtly wrong.
  const out = {};
  for (const s of [...divergent].sort()) out[s] = { why: reasonOf(declared[s]) || "TODO: why this differs from the approved design", shipped: shippedBody(s) };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
console.log(`parity: ${ship.size} shipped rules against ${spec.size} in the spec`);
console.log(`  added ${added.length}  changed ${changed.length}  dropped ${dropped.length}  declared ${Object.keys(declared).length}`);
console.log(transcriptionComplete
  ? "  the transcription is complete (4 views wired, 3 pages in the shell), so DROPPED is gated too"
  : `  mid-transcription (${wiredViews.length}/4 views wired, ${pagesInShell.length}/3 pages in the shell): ${dropped.length} dropped rules are the slices that have not landed, and are not gated yet`);
for (const s of undeclared) {
  const why = added.includes(s) ? "not in the spec" : changed.includes(s) ? "declarations differ" : "in the spec, not shipped";
  console.error(`  UNDECLARED (${why}): ${s}`);
}
for (const s of stale) console.error(`  STALE DEPARTURE, no longer differs, remove it: ${s}  ("${reasonOf(declared[s])}")`);
for (const s of wrongBody) {
  const want = bodyOf(declared[s]);
  console.error(`  DECLARED WITH A DIFFERENT BODY: ${s}`);
  console.error(`      declared: ${want === null ? "(selector only - a declaration must name what we ship)" : want}`);
  console.error(`      shipped:  ${shippedBody(s)}`);
}
if (undeclared.length || stale.length || wrongBody.length) {
  console.error(`parity: ${undeclared.length} undeclared divergence(s), ${stale.length} stale departure(s), ${wrongBody.length} declared with a different body`);
  console.error(`Declare a deliberate one in ${DEPARTURES} with the reason, or restore the spec's rule.`);
  process.exit(1);
}
console.log("parity: every divergence is declared, and every declaration still describes one");
