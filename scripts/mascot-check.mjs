/**
 * The mascot's acceptance test, ported from `mascot-shots.mjs` in the frozen snapshot
 * `S2-S5-20260915T1958Z` (MASCOT.md, owner ruling 2026-09-15T19:40Z) and turned from a script
 * that PRINTS into one that FAILS. It replaces the retired fox sweep.
 *
 * That snapshot supersedes 1943Z, which is what this was first written against; the only
 * changes are MASCOT.md's new theme-key section and mascot-shots.mjs taking a base URL, both
 * of which came out of this port. The numbers below are unchanged between the two, checked
 * rather than assumed.
 *
 * What it holds, all from MASCOT.md:
 *   - both sheets are served (200) and each is under the size gate, as WebP
 *   - the pointer picks the head's sector: left / up / down-right select the background
 *     positions `0% 50%` / `50% 0%` / `100% 100%` on the directions layer
 *   - a click puts the reactions layer at opacity 1
 *   - both themes at three viewports, no page scroll on desktop, no console errors
 *
 * WHETHER IT APPLIES IS A WIRING FACT, NOT A FILENAME. The first version of this gate keyed on
 * a component file existing, and SDE-App's review of #562 showed why that is wrong: a
 * component lands in one PR and the view is wired in another, so the marker goes true while
 * the page is still the old markup and a correct tree goes red. What says the mascot is wired
 * is `page.tsx` rendering it.
 *
 *   marker absent                  -> not applicable, exit 0, and say so
 *   marker present, no .mascot-riso -> FAIL: that is what a rename looks like
 *   both                            -> run every combination, or fail saying how many it got
 *
 * Run: node scripts/mascot-check.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";

const PAGE = "src/app/page.tsx";
const BASE = process.argv[2] || process.env.UI_SMOKE_URL || "http://localhost:3120";
const SHEETS = [
  { path: "/mascots/fox-riso-directions.webp", limit: 300 * 1024 },
  { path: "/mascots/fox-riso-reactions.webp", limit: 300 * 1024 },
];
// MASCOT.md's own list. Held to the ruling's count below rather than trusted as one, because
// an array quietly losing an entry is a run that measured everything it happened to plan
// (SDE-App, review of #563).
const VIEWPORTS = [[1440, 900], [1100, 800], [390, 844]];
const THEMES = ["paper", "ink"];
const POINTER = [
  { name: "left", dx: -400, dy: 0, want: "0% 50%" },
  { name: "up", dx: 0, dy: -300, want: "50% 0%" },
  { name: "down-right", dx: 300, dy: 250, want: "100% 100%" },
];
// EACH ARRAY, NOT THEIR PRODUCT (CTO red-team, review of #563): 2 themes to 1 with the viewport
// list padded to 6 keeps the product and never renders the ink theme. A product is one number
// standing in for three, which is the same substitution this file exists to refuse.
const RULING_VIEWPORTS = 3;
const RULING_THEMES = 2;
const RULING_COMBOS = RULING_VIEWPORTS * RULING_THEMES;
const RULING_POINTER = 3;  // the three sectors MASCOT.md names
if (VIEWPORTS.length !== RULING_VIEWPORTS || THEMES.length !== RULING_THEMES || POINTER.length !== RULING_POINTER) {
  console.error(`mascot-check: this file has ${VIEWPORTS.length} viewports, ${THEMES.length} themes and ${POINTER.length} pointer sectors, and MASCOT.md names ${RULING_VIEWPORTS}, ${RULING_THEMES} and ${RULING_POINTER}. Change the arrays and these numbers together, deliberately, or neither.`);
  process.exit(1);
}

const wired = existsSync(PAGE) && /<Mascot[\s/>]/.test(readFileSync(PAGE, "utf8"));
if (!wired) {
  console.log(`mascot-check: ${PAGE} does not render <Mascot>, so the mascot is not wired into this tree yet. NOT APPLICABLE, not passed.`);
  process.exit(0);
}

const fails = [];
const errors = [];
const browser = await chromium.launch();

// THE SHEETS FIRST, because a 404 here is a fox-shaped hole on the live page and the pointer
// assertions below would still pass over it: background-position is set on an element whose
// image never loaded.
const probe = await browser.newPage();
for (const { path, limit } of SHEETS) {
  const res = await probe.request.get(BASE + path).catch(() => null);
  if (!res || res.status() !== 200) { fails.push(`${path} is not served (${res ? res.status() : "no response"})`); continue; }
  const body = await res.body();
  const type = (res.headers()["content-type"] || "").toLowerCase();
  // THE BYTES, NOT THE HEADER. A WebP is "RIFF" + 4 length bytes + "WEBP", and that is what
  // the ruling means by WebP: a server that labels it application/octet-stream still serves a
  // WebP and a browser still renders it, while a PNG labelled image/webp is the regression
  // this is looking for. Measured against the frozen preview, whose server sends no type for
  // .webp at all - gating on the header would have failed a file that is exactly right.
  const isWebp = body.length > 12 && body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP";
  if (!isWebp) fails.push(`${path} is not a WebP (first bytes ${body.subarray(0, 12).toString("latin1").replace(/[^\x20-\x7e]/g, ".")})`);
  if (body.length > limit) fails.push(`${path} is ${body.length} bytes, over the ${limit} gate`);
  console.log(`${path}: ${res.status()} ${body.length} bytes, WebP ${isWebp}, content-type ${type || "(none)"}`);
}
await probe.close();

let combos = 0;
let sectors = 0;
for (const [w, h] of VIEWPORTS) {
  for (const theme of THEMES) {
    const where = `${w}x${h} ${theme}`;
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    page.on("pageerror", (e) => errors.push(`${where}: ${String(e)}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${where}: ${m.text()}`); });
    // THE APP'S KEY, NOT THE PREVIEW'S. layout.tsx's pre-paint boot script reads
    // `zfaucet_theme`; the preview's own scripts use `faucet-theme`, and porting that
    // spelling across would have set a key nothing reads - both "themes" would have been
    // paper, twice, and the run would have looked complete. The two spec scripts disagree
    // with each other on this, so the app is the authority.
    await page.addInitScript((t) => { try { localStorage.setItem("zfaucet_theme", t); } catch { /* private window */ } }, theme);
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    if (await page.locator(".mascot-riso").count() === 0) {
      fails.push(`${PAGE} renders <Mascot> but ${BASE}/ has no .mascot-riso at ${where}`);
      await page.close();
      continue;
    }
    const geom = await page.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      innerH: window.innerHeight,
    }));
    // Desktop only: the phone viewport scrolls by design.
    if (w >= 1000 && geom.scrollH > geom.innerH + 1) fails.push(`${where}: the page scrolls (${geom.scrollH} > ${geom.innerH})`);
    combos += 1;

    // The pointer sectors and the boop, once, at the size MASCOT.md measures them at.
    if (w === 1440 && theme === "paper") {
      const centre = await page.evaluate(() => {
        const r = document.querySelector(".mascot-riso").getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      for (const { name, dx, dy, want } of POINTER) {
        await page.mouse.move(centre.x, centre.y);
        await page.mouse.move(centre.x + dx, centre.y + dy, { steps: 12 });
        await page.waitForTimeout(350);
        const pos = await page.evaluate(() => {
          const el = document.querySelector(".mascot-riso span span");
          return el ? getComputedStyle(el).backgroundPosition : null;
        });
        if (pos !== want) fails.push(`pointer ${name}: the directions layer reads ${pos}, not ${want}`);
        else sectors += 1;
        console.log(`pointer ${name}: ${pos}`);
      }
      // THE REACTIONS LAYER BY NAME, NOT "ONE OF THE TWO" (CTO red-team, review of #563). This
      // read `.mascot-riso span span`, which matches BOTH sprite layers, and the DIRECTIONS
      // layer has no opacity rule so it is 1 always - so `some(o => o === 1)` was true before
      // any click, and deleting the click handler outright still passed. The layer is found by
      // the sheet it paints, and the assertion is that ITS opacity RISES.
      const layerOf = (which) => {
        const layers = [...document.querySelectorAll(".mascot-riso span span")];
        const el = layers.find((l) => (getComputedStyle(l).backgroundImage || "").includes(which));
        return el ? Number(getComputedStyle(el).opacity) : null;
      };
      // THE REACTION IS TRANSIENT, so a single sample after a fixed wait is a coin flip. MASCOT.md
      // calls it "blink then a payoff on click": the layer rises and falls again. Sampling once
      // at 250 ms gave 0 -> 1 on one run and 0 -> 0 on the next against an UNCHANGED page, which
      // is a flaky gate - worse than no gate, because it teaches people to re-run CI. Polled for
      // the PEAK across a window instead, which is the property: a click makes it fully visible
      // at some point.
      const beforeBoop = await page.evaluate(layerOf, "reactions");
      await page.click(".mascot-riso");
      let afterBoop = 0;
      for (let waited = 0; waited < 2000 && afterBoop !== 1; waited += 50) {
        afterBoop = Math.max(afterBoop, await page.evaluate(layerOf, "reactions") ?? 0);
        if (afterBoop !== 1) await page.waitForTimeout(50);
      }
      if (beforeBoop === null) {
        fails.push("no layer paints the reactions sheet, so the boop assertion measured nothing");
      } else {
        if (!(beforeBoop < 1)) fails.push(`the reactions layer is already at opacity ${beforeBoop} before any click, so a rise cannot be observed`);
        if (afterBoop !== 1) fails.push(`a click never took the reactions layer to opacity 1 (peak ${afterBoop} over 2 s)`);
      }
      console.log(`boop: reactions layer ${beforeBoop} -> peak ${afterBoop}`);
    }
    await page.close();
  }
}
await browser.close();

// A RUN THAT MEASURED NOTHING IS NOT A PASS.
if (combos !== RULING_COMBOS) fails.push(`measured ${combos} of ${RULING_COMBOS} viewport/theme combinations, so this run proves nothing`);
if (sectors !== RULING_POINTER) fails.push(`checked ${sectors} of ${RULING_POINTER} pointer sectors`);

console.log(`mascot-check: ${combos}/${RULING_COMBOS} combinations, ${sectors}/${RULING_POINTER} sectors, ${errors.length} console errors, ${fails.length} failures`);
for (const f of fails) console.error(`  FAIL ${f}`);
for (const e of errors) console.error(`  console ${e}`);
process.exit(fails.length || errors.length ? 1 : 0);
