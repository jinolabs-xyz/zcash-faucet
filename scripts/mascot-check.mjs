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
import { createHash } from "node:crypto";

const PAGE = "src/app/page.tsx";
const BASE = process.argv[2] || process.env.UI_SMOKE_URL || "http://localhost:3120";
const SHEETS = [
  // THE SERVED PAIR, not the bare one. Pointing this at files the page no longer loads would
  // leave the weight gate green while the actual first load doubled - the blindfolded sheets came
  // out at 630 KB and 785 KB before they were re-encoded, both over this limit.
  { path: "/mascots/fox-riso-directions-blindfold.webp", limit: 300 * 1024 },
  { path: "/mascots/fox-riso-reactions-blindfold.webp", limit: 300 * 1024 },
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

const SERVED_SHEETS = [
  // Pinned to WHAT WE SERVE: Mascot.tsx points at these two, not at the bare sheets.
  { path: "/mascots/fox-riso-directions-blindfold.webp", bare: "/mascots/fox-riso-directions.webp",
    w: 1080, h: 1080, mustCover: true,
    sha256: "aab137f77a073e88852e1d7cee0c3c653411cce6ea7d8e455b6e21c1dc731c27" },
  { path: "/mascots/fox-riso-reactions-blindfold.webp", bare: "/mascots/fox-riso-reactions.webp",
    w: 1080, h: 1080, mustCover: false,
    sha256: "7a6d1a4cb429d350cd8a6bf089eec50782da170606f03afb783aceaa7ac95065" },
];

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

// ── THE BLINDFOLD IS WHERE THE EYES ARE, AND IS NOT WHERE THE EXPRESSIONS ARE ─────────────────
//
// The check above proves a sheet is SERVED. It says nothing about what is ON it, and the pointer
// assertions below would pass over a sheet with no band drawn at all - they read
// background-position, not pixels. These rows read pixels.
//
// THE ANCHORS ARE MEASURED, NOT ASSUMED, frame by frame off the source art (SDE-UI 2026-09-20).
// SIX OF THE NINE DIRECTION FRAMES HAVE ONLY ONE EYE - the head turn hides the far one - so those
// carry a single anchor. A row expecting two would be asserting against art that does not exist.
//
// AND THE SPAN IS THE EYE'S EXTENT, NOT ITS CENTRE. A band centred on a centre covers that centre
// while leaving most of the eye showing: variant C round one scored twelve of twelve on a
// centre-point check with 45 px of eye visible above and below a 22 px band. EYE_HALF sits inside
// the measured half-height (32-34 px), so this tests the eye's core and not an edge pixel.
// TWO WINDOWS, BECAUSE THE TWO SHEETS HAVE DIFFERENT EYES AND ONE NUMBER FOR BOTH IS WRONG.
// DIRECTION eyes are open ellipses 64-68 px tall, so 30 sits inside them and tests the core.
// REACTION eyes are thin closed arcs and icons, and the marks ABOVE them - brow ticks, the sparkle
// - start around y=142. A 30 px half-window there reaches up into the brow and counts a correctly
// pushed-up band as an intrusion: it reported 8 band px on eight of nine frames against a band
// whose lower edge sits at about y=151, which is above every eye and below nothing.
// Measured per frame on the BARE sheet, the smallest reaction feature half-height is 23 px (dizzy),
// so 20 is inside ALL nine. Chosen from that measurement, not by lowering it until the row passed.
const EYE_HALF = 30;
const REA_EYE_HALF = 20;
const DIR_ANCHORS = {
  "0,0": [[182, 153]], "0,1": [[137, 138], [217, 138]], "0,2": [[172, 152]],
  "1,0": [[148, 172]], "1,1": [[138, 170], [216, 170]], "1,2": [[207, 172]],
  "2,0": [[164, 201]], "2,1": [[139, 210], [216, 210]], "2,2": [[190, 201]],
};
// Every reaction frame is front-on with its eyes in the same place; dizzy's spirals are wider.
const REA_ANCHORS = Object.fromEntries(
  [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => [`${r},${c}`,
    r === 2 && c === 1 ? [[129, 174], [227, 174]] : [[138, 174], [222, 174]]])),
);

for (const { path, bare, sha256, w: wantW, h: wantH, mustCover } of SERVED_SHEETS) {
  const res = await probe.request.get(BASE + path).catch(() => null);
  if (!res || res.status() !== 200) { fails.push(`${path} is not served`); continue; }
  const body = await res.body();

  // SHA AND DIMENSIONS PINNED TO WHAT WE SERVE. A re-encode that changes a byte is a deliberate
  // act and updates this constant; a silent one is what this catches.
  const gotSha = createHash("sha256").update(body).digest("hex");
  if (gotSha !== sha256) {
    fails.push(`${path} sha256 ${gotSha}, pinned ${sha256} - if the render was deliberate, update SERVED_SHEETS`);
  }
  // VP8X carries width-1 and height-1 as three little-endian bytes each.
  const fourcc = body.subarray(12, 16).toString("latin1");
  const gotW = fourcc === "VP8X" ? 1 + body.readUIntLE(24, 3) : 0;
  const gotH = fourcc === "VP8X" ? 1 + body.readUIntLE(27, 3) : 0;
  if (gotW !== wantW || gotH !== wantH) fails.push(`${path} is ${gotW}x${gotH}, pinned ${wantW}x${wantH} (fourcc ${fourcc})`);

  // THE CLOTH IS WHAT CHANGED, NOT WHAT IS DARK. This compares the served sheet against the BARE
  // one frame for frame; the band is the difference between them.
  //
  // I WROTE THE DARKNESS VERSION FIRST AND IT WAS WRONG. It tested "is this pixel near-black",
  // which cannot tell cloth from an eye, because the art's teal ink is near-black too. Positive
  // control that caught it: run the same detector over the sheet with NO band drawn and it returns
  // the IDENTICAL counts - 8, 8, 8, 40, 18, 8, 8, 18, 8 across the nine reaction frames. It was
  // reading the eyes and reporting them as an intrusion, which would have blocked this PR on a
  // defect that does not exist. SDE-App hit the same trap from the other direction and said so;
  // I then reproduced it.
  // Difference is immune to the colour question entirely: whatever the band is drawn in, it is not
  // what was there before.
  const pg = await browser.newPage();
  // SAME ORIGIN FIRST, OR THE CANVAS IS TAINTED. Reading pixels back from an image drawn onto a
  // canvas is forbidden when the image came from a different origin than the document - and
  // about:blank is a different origin from the app. Navigating to the app and then loading the
  // sheet by a RELATIVE path makes them the same origin, which is the only reason getImageData is
  // allowed to answer. Without this the whole block throws SecurityError and every row is silently
  // not run.
  await pg.goto(BASE, { waitUntil: "domcontentloaded" });
  const sampled = await pg.evaluate(async ({ url, bareUrl, anchors, half }) => {
    const grab = async (u) => {
      const img = new Image();
      img.src = u;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return ctx;
    };
    const A = await grab(url), B = await grab(bareUrl);
    const out = {};
    for (const [cell, pts] of Object.entries(anchors)) {
      const [r, c] = cell.split(",").map(Number);
      out[cell] = pts.map(([ax, ay]) => {
        const X = c * 360 + ax, Y = r * 360 + ay - half, N = half * 2 + 1;
        const a = A.getImageData(X, Y, 1, N).data;
        const b = B.getImageData(X, Y, 1, N).data;
        let band = 0;
        for (let k = 0; k < a.length; k += 4) {
          // a material change, not re-encode noise
          const d = Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]);
          if (d > 60) band++;
        }
        return { band, total: N };
      });
    }
    return out;
  }, { url: path, bareUrl: bare, anchors: mustCover ? DIR_ANCHORS : REA_ANCHORS, half: mustCover ? EYE_HALF : REA_EYE_HALF });
  await pg.close();

  for (const [cell, pts] of Object.entries(sampled)) {
    pts.forEach(({ band, total }, k) => {
      const pct = Math.round((100 * band) / total);
      if (mustCover && pct < 90) {
        fails.push(`${path} (${cell}) eye ${k}: cloth covers ${pct}% of the eye's extent, needs >=90% - the eye is showing`);
      }
      if (!mustCover && band > 0) {
        fails.push(`${path} (${cell}) eye ${k}: ${band} px changed over the eye - the pushed-up band has dropped onto the expression`);
      }
    });
  }
  console.log(`${path}: sha ok, ${gotW}x${gotH}, ${Object.keys(sampled).length} frames sampled for ${mustCover ? "cover" : "clear"}`);
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
      // A SINGLE SAMPLE AT 250 ms GAVE 0 -> 1 ON ONE RUN AND 0 -> 0 ON THE NEXT against an
      // UNCHANGED page - a flaky gate, worse than no gate, because it teaches people to re-run
      // CI. My first reading of WHY was wrong, and the CTO's red-team caught it: I said the
      // reaction is transient and I was sampling past it. It is not transient at 250 ms. The
      // preview's port of this component (MASCOT.md: the two behave the same) sets the layer to
      // opacity 1 on click, swaps the cell to a payoff at BOOP_PAYOFF = 120 ms, and only drops
      // back to 0 at BOOP_END = 560 ms. So 250 ms lands INSIDE the visible window, and a 0 there
      // means the click produced no reaction at all - the handler was not attached yet.
      // The poll is still the fix, but it is waiting for hydration rather than chasing a peak,
      // which is why the window is 2 s and not 600 ms. Kept as a peak so a slow frame late in
      // the window cannot fool it either.
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
