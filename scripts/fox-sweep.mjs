/**
 * Sweeps the pointer across the mascot at three viewports in both themes and photographs it
 * at nine pointer stops each: 54 shots. scripts/fox-check.py then reads every shot for holes
 * in the silhouette, doubled fur below the collar, a second face above it and a protruding
 * shoulder. This script CAPTURES; the checking is the python step, and its exit code is the
 * verdict. Exiting 0 here means "the photographs were taken", never "the fox is right".
 *
 * Ported from the redesign preview's fox-test.mjs, the spec the owner approved. Changes:
 * the base URL is an argument rather than the preview's port, and whether the check applies
 * is decided from a file in the repo rather than from what is on the page.
 *
 *   - no FOX_MARKER in the tree          -> the mascot has not shipped yet: NOT APPLICABLE
 *   - FOX_MARKER present, no .mascot-frame -> FAIL, because that is what a rename looks like
 *   - both                                -> take all 54, or fail saying how many it got
 *
 * Run: node scripts/fox-sweep.mjs <outdir> [baseUrl]
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

// S2 adds the mascot. This path is the one fact that says it is in this tree, and
// deploy/z3/tests/suites/repo.sh pins that the CI step names the same one.
const FOX_MARKER = "src/components/Mascot.tsx";
const out = process.argv[2] || "fox-shots";
const BASE = process.argv[3] || process.env.UI_SMOKE_URL || "http://localhost:3120";
const VIEWPORTS = [[1440, 900], [768, 1024], [390, 844]];
const THEMES = ["paper", "ink"];
const EXPECTED = VIEWPORTS.length * THEMES.length * 9;

if (!existsSync(FOX_MARKER)) {
  console.log(`fox-sweep: no ${FOX_MARKER} in this tree, so the mascot has not shipped yet. NOT APPLICABLE, not passed.`);
  process.exit(0);
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const report = [];
let missing = null;

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    const where = `${vp.join("x")} ${theme}`;
    const page = await browser.newPage({
      viewport: { width: vp[0], height: vp[1] },
      reducedMotion: "no-preference",
      isMobile: vp[0] < 500,
      hasTouch: vp[0] < 500,
    });
    page.on("pageerror", (e) => errors.push(`${where}: ${String(e)}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${where}: ${m.text()}`); });
    await page.goto(`${BASE}/?test=1`, { waitUntil: "networkidle" });
    if (await page.locator(".mascot-frame").count() === 0) {
      missing = `${FOX_MARKER} is in the tree but ${BASE}/ has no .mascot-frame at ${where}`;
      await page.close();
      break;
    }
    // Magenta ground with everything but the fox hidden: a hole in the silhouette is then
    // unambiguous against any fox colour, which is what makes the python check possible.
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      const st = document.createElement("style");
      st.textContent = ".stage, body { background: #ff00ff !important } .hero-copy, #claim, .hdr, .seg, .ftr, .mascot-cap { visibility: hidden !important }";
      document.head.append(st);
    }, theme);
    await page.waitForTimeout(3500);
    const fw = Math.min(600, Math.floor(vp[0] * 0.9));
    await page.evaluate((w) => {
      const f = document.querySelector(".mascot-frame");
      f.style.maxWidth = `${w}px`; f.style.width = `${w}px`;
      f.scrollIntoView({ block: "center" });
    }, fw);
    await page.waitForTimeout(300);
    const frame = page.locator(".mascot-frame");
    const box = await frame.boundingBox();
    const stops = [];
    for (const fy of [0.01, 0.5, 0.99]) for (const fx of [0.01, 0.5, 0.99]) stops.push([Math.round(vp[0] * fx), Math.round(vp[1] * fy)]);
    for (const [x, y] of stops) {
      await page.mouse.move(x, y, { steps: 8 });
      await page.waitForTimeout(1300);
      const name = `${vp.join("x")}_${theme}_${x}_${y}.png`;
      await frame.screenshot({ path: `${out}/${name}` });
      const t = await page.evaluate(() => { const h = document.getElementById("m-head"); return h ? h.style.transform : ""; });
      report.push({ vp: vp.join("x"), theme, x, y, head: t, file: name, frameW: Math.round(box.width) });
    }
    await page.close();
  }
  if (missing) break;
}
await browser.close();

if (missing) { console.error(`fox-sweep: FAIL - ${missing}`); process.exit(1); }

// THE COUNT IS PART OF THE CAPTURE'S CONTRACT. fox-check.py reads whatever it is handed, so
// a sweep that quietly took six shots would be analysed, come back clean and read as a pass.
// The expected number lives here, beside the loops that produce it.
writeFileSync(`${out}/report.json`, JSON.stringify({ errors, report, expected: EXPECTED }, null, 2));
console.log(JSON.stringify({ shots: report.length, expected: EXPECTED, errors }));
if (report.length !== EXPECTED) {
  console.error(`fox-sweep: FAIL - captured ${report.length} of ${EXPECTED} shots`);
  process.exit(1);
}
