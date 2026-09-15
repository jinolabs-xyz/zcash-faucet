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
import { existsSync, readFileSync } from "node:fs";

// S1 adds this file. It is the one fact that says "the redesign shell is in this tree".
const SHELL_MARKER = "src/app/redesign-tokens.css";
const BASE = process.argv[2] || process.env.UI_SMOKE_URL || "http://localhost:3120";
// THE DESIGN'S THREE, PLUS THE TWO THE FAILURE ACTUALLY APPEARS AT. The brief names 1440x900,
// 1280x800 and 1920x1080, and #562's clipped footer was invisible at all three: the red-team
// found it at 1024x768, 1280x720, 1366x768 and 1440x810, which is what ordinary laptops are.
// A fit check whose sizes cannot show the fault is arithmetic, not a gate, so the two most
// common of those are in the list. Raised with the CTO rather than decided quietly, since it
// widens what the ruling's number means.
const SIZES = [[1440, 900], [1280, 800], [1920, 1080], [1366, 768], [1280, 720]];
const THEMES = ["paper", "ink"];
const VIEWS = ["claim", "status", "analytics", "tools"];
const PAGES = ["/terms", "/donate", "/fund"];

// THE SAME HOLD, for the same reason: the combination count comes out of the arrays below,
// so shrinking one of them would leave a run that "measured everything it meant to".
// THE PAGES JOIN THE CONTRACT WHEN THEY JOIN THE SHELL, and not before. Measured against S1:
// /terms, /donate and /fund are still the pre-redesign layout with no .stage at all, because
// they enter the shell in S5 - so requiring them here would have turned main red the moment
// S1 merged. Whether a page is in the shell is a REPO fact (its own source names the shell),
// which keeps this out of the "absent, so skip" shape: a page whose source says stage MUST
// render one, and one whose source does not is not yet in this contract.
const PAGES_IN_SHELL = PAGES.filter((route) => {
  const src = `src/app${route}/page.tsx`;
  return existsSync(src) && readFileSync(src, "utf8").includes('"stage"');
});
const RULING_COMBOS = 70;   // 5 sizes x 2 themes x (4 views + 3 pages), once every page is in the shell
// THE PART THAT DOES NOT DEPEND ON WHICH SLICES HAVE LANDED (SDE-App, review of #563). The
// full count is only checkable at the end, so until then a shrunk array changed PLANNED and the
// measured rows together and they agreed with each other - halving THEMES halved the coverage
// and stayed green. Sizes times themes is fixed from the first slice, so it is checked from the
// first slice.
// EACH ARRAY, NOT THEIR PRODUCT (CTO red-team, review of #563): padding one list while halving
// the other keeps the product and silently drops a theme.
const RULING_SIZES = 5;
const RULING_THEMES = 2;
const RULING_VIEWPORT_PASSES = RULING_SIZES * RULING_THEMES;
if (SIZES.length !== RULING_SIZES || THEMES.length !== RULING_THEMES) {
  console.error(`fit-check: this file has ${SIZES.length} sizes and ${THEMES.length} themes, and the ruling is ${RULING_SIZES} and ${RULING_THEMES}. Change the arrays and these numbers together, deliberately, or neither.`);
  process.exit(1);
}
const PLANNED = SIZES.length * THEMES.length * (VIEWS.length + PAGES_IN_SHELL.length);
if (PAGES_IN_SHELL.length === PAGES.length && PLANNED !== RULING_COMBOS) {
  console.error(`fit-check: every page is in the shell, so this file should plan ${RULING_COMBOS} combinations and it plans ${PLANNED}. Change the arrays and this number together, deliberately, or neither.`);
  process.exit(1);
}
if (PAGES_IN_SHELL.length !== PAGES.length) {
  console.log(`fit-check: ${PAGES_IN_SHELL.length} of ${PAGES.length} pages are in the shell so far (${PAGES.filter((p) => !PAGES_IN_SHELL.includes(p)).join(", ")} still pre-redesign); planning ${PLANNED} combinations, and the full ${RULING_COMBOS} applies once S5 lands.`);
}

if (!existsSync(SHELL_MARKER)) {
  console.log(`fit-check: no ${SHELL_MARKER} in this tree, so the redesign shell is not here yet and there is nothing to fit. NOT APPLICABLE, not passed.`);
  process.exit(0);
}

// WHAT "FITS" HAS TO MEAN, after the CTO's red-team found the real failure on #562: `.stage` was
// `height:100dvh` with `overflow:hidden`, so content past the fold was not scrolled to, it was
// CLIPPED - the footer was cut by 30 to 93px at ordinary laptop sizes and Donate TAZ, Terms and
// GitHub could not be clicked at all, on a build whose suite reported 130 ok. Arithmetic alone
// would have called that "scrolls" and moved on.
//
// So a page fits when the numbers say so AND the footer is on screen AND every footer link is
// hit-testable where it is drawn. The last one is the property; the first two are how you
// explain it. Run in the page so elementFromPoint sees the real compositing.
// WHICH ELEMENT SCROLLS IS NOT FIXED, and assuming it cost me a false BLOCK on the PR this
// check exists to protect (#562, review of 09e55d6). While `.stage` carried the one-screen
// clamp it was the scroller; with the clamp overridden it is `height:auto` and the DOCUMENT
// scrolls. Reading `.stage` on the fixed page reported "CLIPPED, the page cannot scroll" about
// a page that scrolls perfectly well - the mirror of the mistake this check was written to
// catch, one element over. So the scroller is whichever one actually scrolls, and reachability
// is judged AFTER scrolling rather than from the first paint.
const SCROLL_TO_BOTTOM = () => {
  const st = document.querySelector(".stage");
  if (st && st.scrollHeight > st.clientHeight) st.scrollTop = st.scrollHeight;
  window.scrollTo(0, document.documentElement.scrollHeight);
};

const MEASURE = () => {
  const st = document.querySelector(".stage");
  const ftr = document.querySelector(".ftr");
  const vh = window.innerHeight, vw = window.innerWidth;
  const links = [...document.querySelectorAll(".ftr a")].map((a) => {
    const b = a.getBoundingClientRect();
    const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
    const hit = document.elementFromPoint(x, y);
    return {
      name: (a.textContent || "").trim().slice(0, 24),
      inView: b.top >= 0 && b.bottom <= vh && b.left >= 0 && b.right <= vw,
      reachable: !!hit && (hit === a || a.contains(hit) || hit.contains(a)),
    };
  });
  // THE CAUSE, NOT THE SYMPTOM (SDE-App, from their own #562 fix round, where two assertions in a
  // row passed over the defect). Whether a clamp CUTS depends on content height, so "the footer
  // is visible" and "the links are clickable" are both true on a page that is one paragraph
  // shorter - while the clamp is just as wrong. What is always true is that an ancestor hides
  // its overflow while holding more content than its box. That is the defect; the cut footer is
  // one of its symptoms.
  const clipping = [];
  for (let el = ftr || document.body; el && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const hides = cs.overflowY === "hidden" || cs.overflowY === "clip";
    if (hides && el.scrollHeight > el.clientHeight + 1) {
      clipping.push({
        el: `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""}`,
        hidden: el.scrollHeight - el.clientHeight,
      });
    }
  }
  const fb = ftr ? ftr.getBoundingClientRect() : null;
  const doc = document.documentElement;
  const stScrolls = st ? st.scrollHeight > st.clientHeight : false;
  return {
    clipping,
    // The scroller, named, so a failure says which box it judged.
    scroller: stScrolls ? ".stage" : "document",
    docScroll: doc.scrollHeight, docClient: doc.clientHeight,
    oneScreen: doc.scrollHeight <= doc.clientHeight + 1 && (!st || st.scrollHeight <= st.clientHeight + 1),
    sh: st ? st.scrollHeight : -1, ch: st ? st.clientHeight : -1,
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    theme: document.documentElement.dataset.theme,
    // Clipped rather than scrollable: the overflow exists and nothing can reach it.
    canScroll: st ? st.scrollHeight > st.clientHeight && getComputedStyle(st).overflowY !== "hidden" : false,
    footerBottom: fb ? Math.round(fb.bottom) : null,
    footerCut: fb ? Math.max(0, Math.round(fb.bottom - vh)) : null,
    links,
  };
};

// THE ONE-SCREEN RULE IS KEYED TO THE TREE, not to a date. S1 overrides the clamp on purpose
// while the views hold pre-redesign content, and the CTO's ruling is that it returns with the
// content designed for it, enforced here per slice. So the tree says whether to demand it: the
// override carries its own heading, and its absence is the clamp being back.
const CLAMP_OVERRIDDEN = existsSync("src/app/redesign-shell.css")
  && readFileSync("src/app/redesign-shell.css", "utf8").includes("NOT YET: the one-screen clamp");

// Always: nothing clipped, nothing wider than the screen, and every footer link reachable once
// the reader has scrolled. Additionally, once the clamp is back: it all fits one screen.
const fitsNow = (r) =>
  (r.clipping || []).length === 0 &&
  r.sw <= r.cw &&
  r.links.every((l) => l.inView && l.reachable) &&
  (CLAMP_OVERRIDDEN || r.oneScreen);

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
      // THE APP'S DRIVER, NOT THE PREVIEW'S. The preview's nav is `#seg [data-view="claim"]`;
      // the app's is a testid, which is also what ui-smoke's showView() clicks. Porting the
      // preview's selector cost a 30 s Playwright timeout against the real shell - the same
      // shape as the theme key, and the same lesson: the preview is not the authority on its
      // own consumer. Reported as a failure rather than left to time out, so a renamed
      // control says what it is instead of looking like a hung job.
      const nav = page.getByTestId(`nav-${v}`);
      if (await nav.count() === 0) {
        missing = `${SHELL_MARKER} is in the tree but ${BASE}/ has no [data-testid="nav-${v}"] at ${where}`;
        break;
      }
      await nav.click();
      await page.locator(`[data-testid="view-${v}"]`).waitFor({ state: "visible", timeout: 5000 });
      await page.waitForTimeout(350);
      await page.evaluate(SCROLL_TO_BOTTOM);
      await page.waitForTimeout(150);
      const r = await page.evaluate(MEASURE);
      rows.push({ size: `${W}x${H}`, theme, page: `/#${v}`, ...r, fits: fitsNow(r), themeKept: true });
    }
    if (missing) { await page.close(); break; }
    for (const p of PAGES_IN_SHELL) {
      await page.goto(BASE + p, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      await page.evaluate(SCROLL_TO_BOTTOM);
      await page.waitForTimeout(150);
      const r = await page.evaluate(MEASURE);
      rows.push({ size: `${W}x${H}`, theme, page: p, ...r, fits: r.sh >= 0 && fitsNow(r), themeKept: r.theme === theme });
    }
    await page.close();
  }
  if (missing) break;
}
await browser.close();

if (missing) { console.error(`fit-check: FAIL - ${missing}`); process.exit(1); }

for (const o of rows) {
  const unreachable = (o.links || []).filter((l) => !l.inView || !l.reachable).map((l) => l.name);
  const clipped = (o.clipping || []).map((c) => `${c.el} hides ${c.hidden}px`).join(", ");
  const why = o.fits ? "fits"
    // THE NAMES BELONG ON THIS BRANCH TOO. A clipped row used to print the ancestor and stop,
    // so the links a reader has to go and look at were named on every branch except the one
    // that matters most - and the commit that introduced this line claimed otherwise. The
    // clipping is the cause and the unreachable links are what a person sees.
    : clipped ? `CLIPPED by an ancestor (${clipped})${unreachable.length ? `, unreachable after scrolling: ${unreachable.join(", ")}` : ""}`
    : unreachable.length ? `footer links unreachable after scrolling [${unreachable.join(", ")}]`
    : o.sw > o.cw ? "wider than the screen"
    : !o.oneScreen ? `does not fit one screen (${o.docScroll} of ${o.docClient}), and the clamp is not overridden`
    : "does not fit";
  console.log(`${o.size} ${o.theme.padEnd(5)} ${o.page.padEnd(11)} doc ${o.docScroll}/${o.docClient} via ${o.scroller} ${why}${o.themeKept === false ? " THEME-LOST" : ""}`);
}
console.log("errors:", errors.length ? errors : "none");
// A RUN THAT CHECKED NOTHING IS NOT A PASS. Without this an early `break`, a bad base URL
// or an empty size list would print "errors: none" and exit 0 on zero measurements.
if (rows.length !== PLANNED) {
  console.error(`fit-check: FAIL - measured ${rows.length} of ${PLANNED} planned combinations, so this run proves nothing`);
  process.exit(1);
}
const bad = rows.filter((o) => !o.fits || o.themeKept === false);
console.log(`fit-check: ${rows.length} combinations, ${bad.length} failing, ${errors.length} console errors`);
process.exit(bad.length || errors.length ? 1 : 0);
