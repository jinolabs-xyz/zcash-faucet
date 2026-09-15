/**
 * Every view and every page must fit one screen at desktop sizes, in both themes, with no
 * console errors and the theme surviving a navigation.
 *
 * Ported from the redesign preview's fit-test.mjs, which is the spec the owner approved.
 * Two things changed in the port and both are deliberate.
 *
 * THE BASE URL IS AN ARGUMENT, not localhost:3131. The preview server is not what CI runs.
 *
 * AND IT DECIDES WHETHER IT APPLIES FROM A FILE IN THE REPO, not from what it finds in the
 * page. A check that shrugs when its selectors are missing is the false-green shape we keep
 * killing: it would pass on every ref after a rename, exactly when it is needed. So the
 * rule is three-state and the middle state is the loud one:
 *
 *   - no SHELL_MARKER in the tree      -> this ref predates the redesign shell, not
 *                                         applicable, exit 0 and say so
 *   - SHELL_MARKER present, no .stage  -> FAIL: the shell shipped and this cannot see it,
 *                                         which is what a renamed selector looks like
 *   - both                             -> run the checks
 *
 * Run: node scripts/fit-check.mjs [baseUrl]      (default: $UI_SMOKE_URL)
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

// S1 adds this file. It is the one fact that says "the redesign shell is in this tree".
const SHELL_MARKER = "src/app/redesign-tokens.css";
const BASE = process.argv[2] || process.env.UI_SMOKE_URL || "http://localhost:3120";
const SIZES = [[1440, 900], [1280, 800], [1920, 1080]];
const THEMES = ["paper", "ink"];
const VIEWS = ["claim", "status", "analytics", "tools"];
const PAGES = ["/terms", "/donate", "/fund"];

// THE SAME HOLD, for the same reason: the combination count comes out of the arrays below,
// so shrinking one of them would leave a run that "measured everything it meant to".
const RULING_COMBOS = 42;
const PLANNED = SIZES.length * THEMES.length * (VIEWS.length + PAGES.length);
if (PLANNED !== RULING_COMBOS) {
  console.error(`fit-check: this file plans ${PLANNED} combinations (${SIZES.length} sizes x ${THEMES.length} themes x ${VIEWS.length + PAGES.length} views and pages) but the ruling is ${RULING_COMBOS}. Change the arrays and this number together, deliberately, or neither.`);
  process.exit(1);
}

if (!existsSync(SHELL_MARKER)) {
  console.log(`fit-check: no ${SHELL_MARKER} in this tree, so the redesign shell is not here yet and there is nothing to fit. NOT APPLICABLE, not passed.`);
  process.exit(0);
}

const browser = await chromium.launch();
const rows = [];
const errors = [];
let missing = null;

for (const [W, H] of SIZES) {
  for (const theme of THEMES) {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const where = `${W}x${H} ${theme}`;
    page.on("pageerror", (e) => errors.push(`${where}: ${String(e)}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${where}: ${m.text()}`); });
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    // The shell is in the tree, so it must be on the page. Reported once, as a failure.
    if (await page.locator(".stage").count() === 0) {
      missing = `${SHELL_MARKER} is in the tree but ${BASE}/ has no .stage element at ${where}`;
      await page.close();
      break;
    }
    // `zfaucet_theme` is the key layout.tsx's boot script reads; `faucet-theme` is the
    // preview's. Setting the wrong one still switched the theme through the dataset line
    // here, but every navigation below re-runs that boot script, finds nothing and reverts -
    // so the pages would have been measured in whatever theme the app defaults to while the
    // run reported both. The `themeKept` assertion would have failed for a reason that is
    // mine rather than the page's.
    await page.evaluate((t) => { localStorage.setItem("zfaucet_theme", t); document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(3200);
    for (const v of VIEWS) {
      await page.click(`#seg [data-view="${v}"]`);
      await page.waitForTimeout(350);
      const r = await page.evaluate(() => {
        const st = document.querySelector(".stage");
        return { sh: st.scrollHeight, ch: st.clientHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
      });
      rows.push({ size: `${W}x${H}`, theme, page: `/#${v}`, ...r, fits: r.sh <= r.ch + 1 && r.sw <= r.cw, themeKept: true });
    }
    for (const p of PAGES) {
      await page.goto(BASE + p, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => {
        const st = document.querySelector(".stage");
        return {
          sh: st ? st.scrollHeight : -1, ch: st ? st.clientHeight : -1,
          sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
          theme: document.documentElement.dataset.theme,
        };
      });
      rows.push({ size: `${W}x${H}`, theme, page: p, ...r, fits: r.sh >= 0 && r.sh <= r.ch + 1 && r.sw <= r.cw, themeKept: r.theme === theme });
    }
    await page.close();
  }
  if (missing) break;
}
await browser.close();

if (missing) { console.error(`fit-check: FAIL - ${missing}`); process.exit(1); }

for (const o of rows) {
  console.log(`${o.size} ${o.theme.padEnd(5)} ${o.page.padEnd(11)} scroll ${o.sh}/${o.ch} ${o.fits ? "fits" : "SCROLLS"}${o.themeKept === false ? " THEME-LOST" : ""}`);
}
console.log("errors:", errors.length ? errors : "none");
// A RUN THAT CHECKED NOTHING IS NOT A PASS. Without this an early `break`, a bad base URL
// or an empty size list would print "errors: none" and exit 0 on zero measurements.
if (rows.length !== RULING_COMBOS) {
  console.error(`fit-check: FAIL - measured ${rows.length} of ${RULING_COMBOS} expected combinations, so this run proves nothing`);
  process.exit(1);
}
const bad = rows.filter((o) => !o.fits || o.themeKept === false);
console.log(`fit-check: ${rows.length} combinations, ${bad.length} failing, ${errors.length} console errors`);
process.exit(bad.length || errors.length ? 1 : 0);
