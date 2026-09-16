/**
 * Vendors, beside each spec, every class and id the design's OWN markup uses.
 *
 * WHY THE SPEC ALONE IS NOT ENOUGH. A snapshot's stylesheet carries rules its own page never
 * uses - `.demo`, `.spec`, `.metrics`, `.assistant-head` and thirty-odd more. Without this list
 * parity-check reads every one of them as a design rule WE failed to ship, which was 37 of the
 * 92 divergences the gate reported the day the slice gate armed.
 *
 * They do not belong in departures.json either: an entry there is a `divergence` (a debt of
 * ours against the design) or an `override` (a floor of ours the design cannot satisfy), and
 * dead CSS in the design is neither. Recording it as either would make the file mean both,
 * which is the thing that file's own rules forbid.
 *
 * SCRIPT-ADDED CLASSES COUNT. The preview toggles `entrance-pending` and `entrance-active` from
 * JS, so a list built from `class="..."` alone would call them dead and hide a real rule. The
 * classList and className spellings are read too.
 *
 * Run: node scripts/vendor-markup-selectors.mjs [share-dir]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SHARE = process.argv[2] || join(homedir(), ".claude/ipc/share/redesign-frozen");
// Each vendored spec directory and the snapshot it was cut from. The subpages spec is a slice of
// the same snapshot as the index one, so it shares that snapshot's markup.
const TARGETS = [
  ["design/spec/S1-20260915T1938Z", "S1-20260915T1938Z"],
  ["design/spec/S2-S5-20260915T2224Z", "S2-S5-20260915T2224Z"],
  ["design/spec/S2-S5-20260915T2224Z-subpages", "S2-S5-20260915T2224Z"],
];

let wrote = 0;
for (const [outdir, snap] of TARGETS) {
  const dir = join(SHARE, snap);
  if (!existsSync(dir)) { console.error(`missing snapshot ${dir}`); process.exit(1); }
  const names = new Set();
  const seen = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".html")).sort()) {
    const t = readFileSync(join(dir, f), "utf8");
    seen.push(`${f} (${t.length} bytes)`);
    for (const m of t.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) names.add(c);
    for (const m of t.matchAll(/id="([^"]*)"/g)) if (m[1]) names.add(m[1]);
    for (const m of t.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'\)/g)) names.add(m[1]);
    for (const m of t.matchAll(/className\s*=\s*['"]([^'"]+)['"]/g)) for (const c of m[1].split(/\s+/)) if (c) names.add(c);
  }
  const header = [
    `# EVERY CLASS AND ID THE DESIGN'S OWN MARKUP USES, in ${snap}.`,
    "#",
    "# Vendored beside the spec because the spec alone cannot answer \"is this rule part of the",
    "# design\". A snapshot's stylesheet carries rules its own page never uses - .demo, .spec,",
    "# .metrics, .assistant-head and thirty-odd more - and without this list every one of them reads",
    "# as a rule WE failed to ship. They are not a divergence from the design; they are dead CSS in",
    "# the design, and departures.json is the wrong place to record them: an entry there is either a",
    "# `divergence` (a debt of ours) or an `override` (a floor of ours), and this is neither.",
    "#",
    `# Source: ${seen.join(", ")}`,
    "# Includes names the preview's SCRIPT adds (classList.add/remove/toggle), so a class that only",
    "# ever appears at runtime is not mistaken for dead.",
    "#",
    "# Regenerate with scripts/vendor-markup-selectors.mjs; do not hand-edit.",
  ].join("\n");
  writeFileSync(join(outdir, "markup.selectors"), `${header}\n${[...names].sort().map((n) => `${n}\n`).join("")}`);
  console.log(`${outdir}/markup.selectors: ${names.size} names from ${seen.join(", ")}`);
  wrote++;
}
console.log(`${wrote} inventories vendored`);
