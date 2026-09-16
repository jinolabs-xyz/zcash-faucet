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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";

const SPEC = process.argv[2];
const SHIPPED = process.argv.slice(3);
if (!SPEC || SHIPPED.length === 0) {
  console.error("usage: node scripts/parity-check.mjs <spec.css> <shipped.css...>");
  process.exit(2);
}
// DEPARTURES LIVE BESIDE THEIR SPEC, one file per vendored snapshot, because there is more
// than one spec now. A single flat file keyed by selector looked fine until the hero was
// compared against S2's document: every one of S1's fifteen declarations came back as
// "STALE DEPARTURE, no longer differs, remove it", because they do not differ in a comparison
// they were never about. Two comparisons would have spent for ever deleting each other's
// declarations. The spec and the reasons we depart from it are one artefact.
const DEPARTURES = SPEC.replace(/\/[^/]+$/, "/departures.json");

// THE SHEETS ARE DISCOVERED, AND A HAND-WRITTEN LIST THAT MISSES ONE IS A FAILURE
// (CTO red-team, review of this PR). `redesign-hero.css` was not compared at all: the CI step
// named two sheets by hand, the app imports three, and eight divergences had been sitting on
// main since #566 - every one of them reasoned in the file's own comments and none of them in
// departures.json. A parity check that silently omits a sheet is worse than no parity check,
// because the green is read as "the design is transcribed".
//
// So the list is not trusted. Whatever is passed must COVER what the app actually imports,
// and the entry files are read for `import "./x.css"` rather than the sheets being enumerated
// here - a list in this file would drift exactly the way the one in ci.yml did.
//
// AND THE ENTRY LIST WAS THE SAME BUG ONE LEVEL UP. Two files were named here by hand, which
// held exactly as long as every import sat in `src/app/page.tsx`. #576 moves all four into
// `src/components/Shell.tsx` and spells them `@/app/...` rather than `./...`, so BOTH halves of
// the old discovery miss: the file is not read, and the spelling would not have matched if it
// were. Measured on that branch with the listed version: `shouldCompare` comes back EMPTY, an
// empty set satisfies every gate below, both CI invocations exit 0, and `redesign-subpages.css`
// is never compared - a sheet that ships unchecked under a green tick.
//
// So nothing is listed. Every source file under src/ is read and both spellings are resolved.
const SRC_ROOT = "src";
const srcFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = `${dir}/${e.name}`;
  if (e.isDirectory()) return srcFiles(p);
  return /\.(tsx|ts|jsx|js|mjs)$/.test(e.name) ? [p] : [];
});
const resolveSheet = (fromFile, spec) => {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`;
  if (!spec.startsWith(".")) return null;           // a package import, not one of ours
  const out = [];
  for (const seg of `${fromFile.replace(/\/[^/]+$/, "")}/${spec}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
};
const sourceFiles = existsSync(SRC_ROOT) ? srcFiles(SRC_ROOT) : [];
const allImports = sourceFiles.flatMap((f) =>
  [...readFileSync(f, "utf8").matchAll(/^\s*import\s+"([^"]+\.css)"/gm)]
    .map((m) => resolveSheet(f, m[1])).filter(Boolean));
// THE WALK IS ITS OWN CANARY, anchored on the one import this repo has always had: `layout.tsx`
// has imported `globals.css` since before the redesign existed. So in a tree that HAS a
// `src/app/globals.css`, a walk returning no CSS import at all has broken rather than found
// nothing - and the empty set it returns is indistinguishable, downstream, from "this tree has
// no sheets", which is exactly the shape that let #576 through. Anchored on globals rather than
// on "any source file", because a fixture with components that import no CSS is a legitimately
// empty answer and not a broken walk; that distinction cost four fixtures on the first attempt.
if (existsSync(`${SRC_ROOT}/app/globals.css`) && allImports.length === 0) {
  console.error(`parity: ${sourceFiles.length} source files under src/ import no CSS at all, yet src/app/globals.css exists and the layout has always imported it. Sheet discovery is broken; refusing to report parity over an empty set.`);
  process.exit(1);
}
const importedSheets = [...new Set(allImports)];
// globals.css is the pre-redesign sheet and is not part of the transcription; everything else
// the entry files pull in is.
const shouldCompare = importedSheets.filter((f) => !f.endsWith("/globals.css"));
//
// A SHEET WITH NO FROZEN SPEC IS NOT A DEPARTURE, IT IS AN UNCOMPARED SHEET, and the two must
// not be written the same way. `redesign-hero.css` is S2a's; the only vendored spec is S1's
// `shell.css`, and the S2 snapshot ships no CSS at all - its styles are inline in `index.html`.
// Comparing the hero against S1's shell produced nine "undeclared divergences" that are nothing
// of the sort: `.mascot-riso`, `html`, `.views > .view.hero` are not in that document because
// that document is not about them. Declaring them as departures would have put nine invented
// reasons in the file and made the check mean less, not more.
//
// So an imported sheet must be EITHER compared, OR named in departures.json under `_uncompared`
// with a reason. The gap then lives in the same reviewed file as every deliberate departure,
// and it cannot be closed by forgetting.
//
// EVERY SHEET NAMES ITS OWN SPEC, IN A LINE THE CHECKER READS (CTO ruling on finding 3).
// `_uncompared` was my first answer and it was refused, for the right reason: a sheet that is
// imported and not compared is the hole this check exists to close, and a label on the hole
// makes the green mean less rather than more. So the hero is compared - against S2's spec,
// vendored from the frozen snapshot in the same act S1's shell.css was - and every sheet
// carries `@spec <path>` on its first line.
//
// The header comments already said which snapshot each sheet came from, in prose. Prose cannot
// be checked, and one of them still names the LIVE share directory rather than a frozen
// snapshot, which is the moving path this whole file exists to replace.
const SPEC_DECL = /^\/\*\s*@spec\s+(\S+)\s*\*\//;
const specOf = (f) => {
  if (!existsSync(f)) return null;
  const first = readFileSync(f, "utf8").split("\n", 1)[0];
  const m = first.match(SPEC_DECL);
  return m ? m[1] : null;
};
// AN IMPORT OF A SHEET THAT IS NOT THERE IS A NAMED FAILURE, not an ENOENT stack. Found by my
// own slice-gate fixture, which imports a sheet it deliberately does not create: the discovery
// read the path straight and the whole run died with `Error: ENOENT` and a node trace, which
// tells a reader nothing about which import is wrong.
const missingSheets = shouldCompare.filter((f) => !existsSync(f));
if (missingSheets.length) {
  console.error(`parity: the app imports ${missingSheets.join(", ")}, which ${missingSheets.length > 1 ? "do" : "does"} not exist.`);
  process.exit(1);
}
const undeclaredSheets = shouldCompare.filter((f) => !specOf(f));
if (undeclaredSheets.length) {
  console.error(`parity: ${undeclaredSheets.join(", ")} ${undeclaredSheets.length > 1 ? "do" : "does"} not declare a spec.`);
  console.error('Put `/* @spec design/spec/<snapshot>/<file>.css */` on the first line of the sheet, naming the vendored spec it was transcribed from.');
  process.exit(1);
}
const unvendored = shouldCompare.filter((f) => !existsSync(specOf(f)));
if (unvendored.length) {
  for (const f of unvendored) console.error(`parity: ${f} declares ${specOf(f)}, which is not vendored.`);
  console.error("Vendor the spec from the frozen snapshot, with its manifest hash and the extraction command in the header, or correct the declaration.");
  process.exit(1);
}
// And the sheets handed to THIS invocation must all belong to the spec it was given: comparing
// a sheet against another slice's document is how nine non-divergences were nearly declared.
const mismatched = SHIPPED.filter((f) => specOf(f) && specOf(f) !== SPEC);
if (mismatched.length) {
  for (const f of mismatched) console.error(`parity: ${f} declares ${specOf(f)} but is being compared against ${SPEC}.`);
  process.exit(1);
}
// AND THE OTHER DIRECTION, WHICH THE COMMENT ABOVE HAS PROMISED SINCE THE SHEET LIST MOVED OUT
// OF ci.yml AND THE CODE NEVER DID: every sheet the app imports that declares THIS spec has to
// be in THIS invocation. Without it `shouldCompare` was only ever used to check that discovered
// sheets exist, declare a spec, and have it vendored - all of which a sheet can pass while no
// invocation ever compares a single one of its rules.
const uncovered = shouldCompare.filter((f) => specOf(f) === SPEC && !SHIPPED.includes(f));
if (uncovered.length) {
  const many = uncovered.length > 1;
  console.error(`parity: the app imports ${uncovered.join(", ")}, which declare${many ? "" : "s"} ${SPEC}, but ${many ? "they were" : "it was"} not passed to this invocation, so ${many ? "none of their rules are" : "not one of its rules is"} compared.`);
  console.error(`Add ${uncovered.join(" ")} to the parity-check line for ${SPEC} in .github/workflows/ci.yml.`);
  process.exit(1);
}

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
            // DECLARATION ORDER IS KEPT. Sorting made the body a SET of declarations and lost the
            // one thing CSS uses order for inside a rule: a fallback pair. `display:-webkit-box;
            // display:flex` and the same two reversed sort to the same string, so swapping them -
            // which changes which value an old browser ends up with - read as parity.
            addRule(out, context ? `${context} | ${prelude}` : prelude, body.split(";").map((d) => d.trim()).filter(Boolean).join("; "));
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
// A VENDORED HEADER THAT CLOSES ITSELF TURNS ITS OWN PROSE INTO SELECTORS, and this file has
// now done it twice. `*/` is a comment terminator WHEREVER it appears - comments do not nest -
// so a header sentence containing `design/spec/*/ directory` ends the header at the `*/` and
// everything after it is parsed as CSS. The symptom is not an error: it is a plausible-looking
// divergence whose selector is a paragraph, plus a REAL rule below it silently re-keyed, which
// is how it survived a round the first time.
//
// The spec is a golden file, so the fault is always in the file rather than in the parser: a CSS
// parser is right to end that comment. This refuses to report parity over a spec that parsed
// prose, and says where to look.
// THE DETECTOR IS THE COMMENT'S OWN LEADING ASTERISKS, not the key's length. Length was the
// first spelling and it was wrong: `@media (prefers-reduced-motion:reduce) | .entrance-pending
// .card,.entrance-pending .hero-copy,...` is 150 characters of entirely legitimate selector, so
// a length rule fails the S1 spec on a rule that is exactly right. What prose carries and a
// selector does not is the ` * ` of a wrapped block comment, or a `/*` that never got stripped.
const prose = [...spec.keys()].filter((k) => / \* /.test(k) || k.includes("/*"));
if (prose.length) {
  console.error(`parity: ${SPEC} parsed ${prose.length} selector(s) that look like prose, so its header comment closed early.`);
  console.error(`A header must not contain \`*/\` - spell a path as design/spec/<snapshot>/ rather than design/spec/*/.`);
  console.error(`First: ${prose[0].slice(0, 120)}...`);
  process.exit(1);
}
const ship = rules(shipCss);
// DROPPED IS A QUESTION ABOUT THE APP, NOT ABOUT THIS INVOCATION'S SHEETS, and computing it
// from `ship` was wrong in a way nothing could see until the slice gate opened.
//
// ADDED and CHANGED are per-sheet by nature: "this sheet ships a rule the spec does not have",
// "this sheet ships it differently". Routing those by @spec is right. DROPPED asks the opposite
// question - "does the app ship this design rule ANYWHERE" - and both vendored specs are
// WHOLE-PAGE documents cut from one design, so they overlap heavily. A rule the shell spec
// carries is very often shipped by redesign-hero.css or redesign-card.css, which declare the
// index spec and are therefore absent from this invocation's `ship`. It then reads as missing.
//
// Measured on the tree that exposed it: of 206 rules reported DROPPED against the S1 shell
// spec, 141 were shipped in a sheet routed to the other spec. Two thirds of the gate's output
// was false, and only ever visible once the transcription completed and DROPPED began to bite.
// THE UNION IS `shouldCompare` PLUS `SHIPPED`, and the fixture caught me taking only the first.
// A discovered sheet may not exist on disk - the slice-gate fixture imports one it deliberately
// never creates - and a sheet passed on the command line may not be discovered, which is exactly
// the fixture shape the tests use. Taking only the walk made `shipAnywhere` SMALLER than `ship`
// for those, so DROPPED got worse rather than better: 1 became 2 in
// "a rule the spec has and we dropped is reported but not gated mid-transcription".
const shipAnywhere = rules(
  [...new Set([...shouldCompare, ...SHIPPED])]
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n"),
);

// Keys beginning with `_` are notes to the reader, not declarations. Without this the file's own
// header comment was reported as a stale departure, which my own stale check caught on its first
// run - the check working, and a reminder that a data file with prose in it needs a convention.
const declared = Object.fromEntries(
  Object.entries(existsSync(DEPARTURES) ? JSON.parse(readFileSync(DEPARTURES, "utf8")) : {})
    .filter(([k]) => !k.startsWith("_")),
);
// SET EQUALITY, BOTH DIRECTIONS. CHANGED used to fire only when a shipped body was ABSENT from
// the spec's set, which means a selector shipping a strict SUBSET of the spec's bodies read
// clean: every body it had was in the spec, and the selector itself was present so DROPPED did
// not see it either. Deleting a whole rule from a shipped sheet - the single most likely way to
// lose a piece of the approved design - exited 0. Found by the CTO's red-team, who deleted
// `.strip .kv b{font-size:calc(.95*var(--u))}` from redesign-shell.css and watched the strip
// figures fall to .78u with the check silent; changing .95 to .96 was caught, because that ADDS
// a body the spec does not have.
// TWO RULES FOR ONE SELECTOR ARE WHAT A BROWSER APPLIES, NOT TWO THINGS TO MATCH. The sets hold
// whole rule BODIES, so a selector the spec splits and the shipped sheet merges read as a
// divergence with an EMPTY difference on both sides - `.pc .figs b`, measured on #567's head.
// Worse, the split can make a spec declaration DEAD: S2's spec has
//   .pc .figs .big b{font-size:clamp(calc(1.2*var(--u)),1.6vw,calc(1.8*var(--u)))}   line 275
//   .pc .figs .big b{font-size:calc(1.8*var(--u));color:...;font-family:...}         line 294
// Same selector, same specificity, later wins, so the clamp never applies in the preview either.
// Requiring the shipped sheet to carry it would be requiring it to transcribe a dead rule - and
// #567 round one did exactly that and rendered 23.04px where the preview rendered 25.2. The
// round-two measurement at 900/1100/1440/1760 reads 23.4/19.8/25.2/25.2 in both, and 19.8 at
// 1100 where the clamp would give 17.6 is the rendered proof that the clamp is dead.
//
// So a key's rules are reduced the way the cascade reduces them: concatenated in source order,
// and for each property only the LAST RULE that declares it survives.
//
// WITHIN one rule, a repeated property is kept as an ordered pair, because `color:red;
// color:color-mix(...)` is a deliberate fallback - an old browser takes the red - and the
// reverse ships something different. Across rules there is no such thing: a property declared
// again in a later rule is simply dead where it was declared first.
const propOf = (d) => d.slice(0, d.indexOf(":")).trim();
const effectiveDecls = (set) => {
  const rules = [...set].map((b) => b.split(";").map((d) => d.trim()).filter(Boolean));
  const lastRuleFor = new Map();
  rules.forEach((decls, i) => decls.forEach((d) => lastRuleFor.set(propOf(d), i)));
  const out = new Map();                       // property -> its declarations, in order
  rules.forEach((decls, i) => decls.forEach((d) => {
    if (lastRuleFor.get(propOf(d)) !== i) return;       // killed by a later rule
    const k = propOf(d);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(d);
  }));
  return out;
};
const sameBodies = (a, b) => {
  const ma = effectiveDecls(a), mb = effectiveDecls(b);
  if (ma.size !== mb.size) return false;
  for (const [prop, va] of ma) {
    const vb = mb.get(prop);
    if (!vb || vb.length !== va.length || va.some((x, i) => x !== vb[i])) return false;
  }
  return true;
};
const added = [...ship.keys()].filter((s) => !spec.has(s));
const changed = [...ship.keys()].filter((s) => spec.has(s) && !sameBodies(ship.get(s), spec.get(s)));
// A RULE THE DESIGN'S OWN PAGE NEVER USES IS NOT A RULE WE FAILED TO SHIP. The snapshot's
// stylesheet carries `.demo`, `.spec`, `.metrics`, `.assistant-head` and thirty-odd more whose
// selectors match nothing in its own markup - dead CSS in the design. Counted as DROPPED they
// were 37 of the 92 divergences this gate reported the day the slice gate armed, and they would
// have buried the real ones.
//
// They cannot go in departures.json: an entry there is a `divergence` (a debt of ours) or an
// `override` (a floor of ours), and dead design CSS is neither - recording it as either makes
// that file mean both, which its own rules forbid. So the markup inventory is vendored beside
// the spec and they are excluded here, counted out loud rather than silently.
//
// A bare element selector (`body`, `a`) has no class or id to look up and is always live.
// THE DESIGN'S OWN PAGE IS VENDORED BESIDE THE SPEC AND READ DIRECTLY. There is no generated
// list any more, and that is the fix rather than a tidy-up: round three shipped a 36-rule
// exclusion file that CI could not verify - no HTML in the repo, no hash, generated from the
// owner's live snapshot directory, a path outside the repo that repo.sh forbids this script to
// name at all (the spelling is deliberately absent here: that pin is a plain string search and it
// is right to be, since a guard that can be talked around is not one). The CTO's red-team killed it
// with the obvious mutant: delete `.brand .name` from the shell AND strike `name` from the list,
// and the run exits 0. An exclusion list that can be edited to match the thing it excuses is not
// evidence.
//
// Reading the page itself removes the tamper surface: to strike a name you must edit the vendored
// HTML, and its sha256 is pinned in the spec's header against the snapshot's MANIFEST, which
// repo.sh checks from outside. The names are derived the same way every time, so there is nothing
// to regenerate and nothing to keep in step.
//
// SCRIPT-ADDED CLASSES COUNT. The preview toggles `entrance-pending` and `entrance-active` from
// JS and they appear in no `class="..."`, so a sweep of markup alone would call them dead and
// hide a real rule.
const pageFile = readdirSync(dirname(SPEC)).filter((f) => f.endsWith(".html")).sort()[0];
// AND THE PAGE IS PINNED, OR THIS REFUSES TO RUN. Reading the page instead of a generated list
// moves the tamper surface rather than removing it: strike `class="name"` from the HTML and the
// rule it excuses reads as dead in the design again, which is the round-three mutant one file
// along. Measured - it still exited 0 after the list was gone.
//
// So the spec's header carries the page's sha256, taken from the snapshot's MANIFEST, and this
// checks it before comparing anything. Editing the page to excuse a rule now fails here, and
// updating the pin to match is a diff a reviewer reads next to the golden file it describes.
if (pageFile) {
  const want = /([0-9a-f]{64})\s+\.\/(\S+\.html)/.exec(specCss);
  const got = createHash("sha256").update(readFileSync(join(dirname(SPEC), pageFile))).digest("hex");
  if (!want) {
    console.error(`parity: ${SPEC} vendors ${pageFile} but pins no sha256 for it. Put the MANIFEST line in the header: <sha256>  ./${pageFile}`);
    process.exit(1);
  }
  if (want[2] !== pageFile || want[1] !== got) {
    console.error(`parity: ${pageFile} does not match the sha256 ${SPEC} pins for ${want[2]}.`);
    console.error(`  pinned ${want[1]}`);
    console.error(`  actual ${got}`);
    console.error(`A vendored page is a golden file. Re-vendor from the snapshot and update the pin in the same diff; do not edit it to make a check pass.`);
    process.exit(1);
  }
}
const usedNames = pageFile ? (() => {
  const html = readFileSync(join(dirname(SPEC), pageFile), "utf8");
  const names = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) names.add(c);
  for (const m of html.matchAll(/id="([^"]*)"/g)) if (m[1]) names.add(m[1]);
  for (const m of html.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'\)/g)) names.add(m[1]);
  for (const m of html.matchAll(/className\s*=\s*['"]([^'"]+)['"]/g)) for (const c of m[1].split(/\s+/)) if (c) names.add(c);
  return names;
})() : null;
const inDesignMarkup = (sel) => {
  if (!usedNames) return true;
  const names = [...sel.matchAll(/[.#]([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  return names.length === 0 || names.every((n) => usedNames.has(n));
};
const droppedAll = [...spec.keys()].filter((s) => !shipAnywhere.has(s));
const deadInDesign = droppedAll.filter((s) => !inDesignMarkup(s));
const dropped = droppedAll.filter(inDesignMarkup);

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
// AND "IN THE SHELL" IS TWO FACTS, NOT ONE STRING (SDE-UI, review of this PR). The first
// version asked whether the page file itself names the stage. That was true when it was
// written and the Shell extraction moved it: S5 puts a page in the shell by rendering
// <Shell>, and the shell OWNS the stage, so the page file then contains that string zero
// times. Measured against S5's own branch - each of the three pages has `"stage"` 0 times and
// `<Shell` once - so the filter returned [] on precisely the tree it exists to detect, and
// `transcriptionComplete` would have been false for ever. A gate that starts failing at the
// moment it is supposed to switch on.
//
// Either fact alone is a string that can move again. Together they are the wiring: the page
// renders the shell, AND the shell is the thing that carries the stage. The direct spelling
// stays accepted because a page that inlines the stage is genuinely in the shell too.
const SHELL_SRC = "src/components/Shell.tsx";
const shellOwnsStage = existsSync(SHELL_SRC) && readFileSync(SHELL_SRC, "utf8").includes('"stage"');
const pagesInShell = ["/terms", "/donate", "/fund"].filter((r) => {
  const f = `src/app${r}/page.tsx`;
  if (!existsSync(f)) return false;
  const src = readFileSync(f, "utf8");
  return src.includes('"stage"') || (shellOwnsStage && /<Shell[\s/>]/.test(src));
});
// AND A SLICE GATES ON ITS OWN FACTS, not on the shell's. A spec block is a whole PAGE, so
// S2's carries the ninety card-internal rules that belong to S2b - which has no PR yet. Gating
// DROPPED on "the shell transcription is complete" would turn main red for a slice that has
// not shipped, the moment the slices that HAVE shipped finish. So a spec's departures file may
// declare the facts that mean ITS slice is in the tree, and DROPPED is enforced for that spec
// only when all of them hold.
//
// TWO FACTS, NOT ONE, AND NEITHER IS "THE FILE EXISTS" (SDE-App, asked for the S2b marker and
// warning me off the obvious answer). `src/app/redesign-card.css` is ALREADY committed on their
// branch, inert and imported by nothing, so that the transcription could be reviewed before it
// could move a pixel. Gating on the file's presence would have armed DROPPED for ninety rules
// the moment that groundwork merged, with the card still the legacy block. The facts that mean
// the slice is live are that page.tsx IMPORTS the sheet and that page.tsx renders the markup
// the sheet styles. Same shape as the page-in-shell pair, and the same reason: a file in a
// directory is not a wiring.
const sliceFacts = (() => {
  if (!existsSync(DEPARTURES)) return null;
  const d = JSON.parse(readFileSync(DEPARTURES, "utf8"));
  const decl = d._slice;
  if (!decl || !Array.isArray(decl.facts) || decl.facts.length === 0) return null;
  return decl;
})();
// A FACT MAY HAVE MORE THAN ONE TRUE SPELLING, and the third instance of that in this file is
// what forced this. The S2 slice's first fact asked whether `src/app/page.tsx` contains
// "./redesign-card.css". SDE-App's card sheet is imported by `src/components/Shell.tsx` as
// "@/app/redesign-card.css" - a different file AND a different spelling - so the fact read false
// on precisely the tree it exists to detect, exactly like the page-in-shell string did before
// SDE-UI caught it. The failure direction is the dangerous one: the slice never reads as live,
// DROPPED is never gated for that spec, and thirty-one rules go unchecked for ever while the
// gate reports itself healthy.
//
// So a fact is EITHER {file, contains} or {anyOf: [{file, contains}, ...]}, and anyOf holds when
// any branch does. The branches are spellings of one claim, not separate claims - a fact that
// needs two things to be true is still two facts.
const factHolds = (f) => {
  const one = (g) => existsSync(g.file) && readFileSync(g.file, "utf8").includes(g.contains);
  return Array.isArray(f.anyOf) ? f.anyOf.some(one) : one(f);
};
const sliceInTree = sliceFacts ? sliceFacts.facts.every(factHolds) : null;
if (sliceFacts) {
  const held = sliceFacts.facts.filter(factHolds).length;
  console.log(`  slice gate: ${held}/${sliceFacts.facts.length} facts hold${sliceInTree ? "" : `, so DROPPED is not gated yet - ${sliceFacts.why}`}`);
}
const transcriptionComplete = sliceFacts ? sliceInTree : (wiredViews.length === 4 && pagesInShell.length === 3);

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
// TWO KINDS, NAMED, BECAUSE A FILE THAT MEANS BOTH MEANS NEITHER (CTO ruling, after SDE-UI hit
// the case on #576: the design's `.tag` copy control is 26 px at the mobile unit, under the
// 44 px tap-target floor ui-smoke enforces. A faithful transcription broke a rule that lives
// OUTSIDE the spec).
//
//   "divergence" - the shipped CSS differs from the approved design and the design is still the
//                  authority. Somebody chose to differ, and `why` is the justification. These
//                  should trend to zero, and each one is a small debt.
//   "override"   - a rule of ours that the design cannot satisfy: an accessibility floor, a tap
//                  target minimum, a reduced-motion guard. The design is not wrong and this is
//                  not a debt; it will never be reconciled and should not be chased.
//
// Read as one list they are indistinguishable, so "twelve departures" tells a reviewer nothing
// about whether the design is being ignored or protected. Counted apart, the first number is
// the one to drive down and the second is the one to leave alone.
const KINDS = ["divergence", "override"];
const kindOf = (entry) => (typeof entry === "string" ? undefined : entry && entry.kind);
const wrongBody = [...divergent].filter((s) => {
  const e = declared[s];
  if (e === undefined) return false;               // undeclared, reported below
  const want = bodyOf(e);
  if (want === null) return true;                  // declared by selector only: not enough
  return want !== shippedBody(s);
});
// A DECLARATION WITHOUT A KIND IS THE OLD FILE, and the old file is the thing being replaced,
// so it fails rather than defaulting. Defaulting to "divergence" would silently relabel every
// override as a debt; defaulting to "override" would silently excuse every divergence.
const unkinded = Object.keys(declared).filter((s) => !KINDS.includes(kindOf(declared[s])));

const undeclared = [...divergent].filter((s) => !(s in declared));
const stale = Object.keys(declared).filter((s) => !divergent.has(s));

if (process.env.PARITY_PRINT === "1") {
  // Prints the exact entries for the current divergences, so a declaration is copied rather
  // than retyped - a hand-typed body would be one more thing that can be subtly wrong.
  const out = {};
  for (const s of [...divergent].sort()) out[s] = {
    kind: kindOf(declared[s]) || `TODO: one of ${KINDS.join(" | ")} - "divergence" is a debt against the design, "override" is a floor of ours the design cannot satisfy`,
    why: reasonOf(declared[s]) || "TODO: why this differs from the approved design",
    shipped: shippedBody(s),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
console.log(`parity: ${ship.size} shipped rules against ${spec.size} in the spec`);
const byKind = (k) => Object.keys(declared).filter((s) => kindOf(declared[s]) === k).length;
console.log(`  added ${added.length}  changed ${changed.length}  dropped ${dropped.length}  declared ${Object.keys(declared).length}`);
if (deadInDesign.length) console.log(`  and ${deadInDesign.length} spec rule(s) ${pageFile} never uses, which are not ours to ship`);
if (!usedNames) console.log(`  no .html vendored beside this spec, so every unshipped rule counts as dropped - vendor the page the spec was cut from`);
console.log(`  of the declared: ${byKind("divergence")} divergence(s) from the design, ${byKind("override")} override(s) of it`);
// AND THE REASON IT IS NOT GATED IS THE REASON, not the views count. When a spec carries slice
// facts the slice gate decides (line 318) and the views/pages tally is not consulted at all - so
// printing "mid-transcription (4/4 views wired, 3/3 pages in the shell)" the moment #567 and #576
// land would state its own contradiction and send the next reader to wire views that are wired.
console.log(transcriptionComplete
  ? "  the transcription is complete, so DROPPED is gated too"
  : sliceFacts
    ? `  held by the slice gate, not by the views: ${dropped.length} dropped rules are not gated yet (${wiredViews.length}/4 views wired, ${pagesInShell.length}/3 pages in the shell, which this spec does not consult)`
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
for (const s of unkinded) {
  console.error(`  UNKINDED DECLARATION: ${s} has kind ${JSON.stringify(kindOf(declared[s]))}, which is not one of ${KINDS.join(", ")}.`);
}
if (unkinded.length) {
  console.error(`parity: ${unkinded.length} declaration(s) do not say whether they are a divergence from the design or an override of it.`);
  console.error(`A file that means both means neither: "divergence" is a debt against the design, "override" is a floor of ours the design cannot satisfy.`);
}
if (undeclared.length || stale.length || wrongBody.length || unkinded.length) {
  console.error(`parity: ${undeclared.length} undeclared divergence(s), ${stale.length} stale departure(s), ${wrongBody.length} declared with a different body, ${unkinded.length} without a kind`);
  console.error(`Declare a deliberate one in ${DEPARTURES} with the reason, or restore the spec's rule.`);
  process.exit(1);
}
console.log("parity: every divergence is declared, and every declaration still describes one");
