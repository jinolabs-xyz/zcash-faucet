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
// centre-point check with 45 px of eye visible above and below a 22 px band. The cover block below
// holds the band to each eye's own ink run, measured at its column on the bare frame. DIRECTION eyes are solid ink ellipses 64-68 px
// tall with a glint, found from the inside by the cover block below rather than by a radius - a
// radius around the anchor measured the fur around the eye, which is the story told there.
// REACTION eyes are thin closed arcs and icons, and the marks ABOVE them - brow ticks, the sparkle
// - start around y=142. A 30 px half-window there reaches up into the brow and counts a correctly
// pushed-up band as an intrusion: it reported 8 band px on eight of nine frames against a band
// whose lower edge sits at about y=151, which is above every eye and below nothing.
// Measured per frame on the BARE sheet, the smallest reaction feature half-height is 23 px (dizzy),
// so 20 is inside ALL nine. Chosen from that measurement, not by lowering it until the row passed.
const REA_EYE_HALF = 20;
// THE NOSE, per frame, measured off the bare sheet the same way the eyes were (SDE-UI 2026-09-21):
// the largest blob of luminance under 70 in the band 5 to 50 px below the eye line with the eye
// boxes blanked, then each centre checked by eye against the art. Six frames turn the head, so the
// nose is not the frame's centre and one number for all nine would be wrong for six.
const NOSE_ANCHORS = {
  "0,0": [108, 159], "0,1": [176, 148], "0,2": [245, 158],
  "1,0": [88, 201], "1,1": [176, 193], "1,2": [265, 201],
  "2,0": [111, 235], "2,1": [177, 245], "2,2": [243, 235],
};
// The nose window: 20 px either side, from the nose's CENTRE row down 14 - beside and below the
// nose, where the muzzle's cream is, and not above it, where a correct band legitimately ends.
const NOSE_HX = 20, NOSE_DOWN = 14;
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

  // TWO SHEETS, TWO QUESTIONS. The reaction sheet must have NOTHING drawn over the eyes, and for
  // that "did any pixel change" is the right instrument. The direction sheet must have the eyes
  // COVERED, and for that it is the wrong one - measured, twice, on this branch:
  //
  //   1. "Is this pixel dark" cannot tell cloth from an eye, because the art's teal ink is
  //      near-black too. Positive control: the same detector over the sheet with NO band returns
  //      the identical counts (8, 8, 8, 40, 18, 8, 8, 18, 8 across the nine reaction frames). It
  //      was reading the eyes.
  //   2. "Did this pixel change" cannot see cloth lying over the eye's own dark ink, because dark
  //      over dark is not a change. That version read 54-79% on a sheet whose eyes are fully
  //      covered at 4x, and - worse - the better the coverage the LOWER it read. It measured a proxy
  //      and the proxy pointed the wrong way (@CTO, @SDE-App, both independently).
  //
  // SO THE COVER ROW MEASURES WHAT A VIEWER SEES. The eye's own light is its GLINT - the iris is
  // solid ink, and the only light inside the eye's outline is that hole, 11-18 px per eye - and on
  // the served frame every glint pixel must read DARK (under 120). That is a direct question about
  // visibility and it has no colour-of-the-cloth problem. A second, independent assertion requires
  // the band's changed-pixel extent at the eye's column to span past the eye in BOTH directions, so
  // a band that hides the glint and stops halfway down the eye still fails.
  //
  // THE NUMBERS ARE MEASURED, AND EACH ASSERTION HAS A MUTANT THAT FAILS IT (SDE-UI 2026-09-21):
  //   - THE EYE IS FOUND FROM THE INSIDE, not by a radius. Two earlier windows - a 60 px square and
  //     then a 30 px disc - counted every light pixel near the anchor and demanded it dark, and
  //     670-820 of those per eye were FUR against 11-18 of eye (@SDE-App measured it, round four).
  //     On the up frame 133 of that fur sat inside the nose window as well, so the cover row and
  //     the nose row demanded opposite things of the same pixels and no sheet could pass both. The
  //     flood fill counts nothing outside the ink, and the overlap with the nose window is asserted
  //     zero on every frame.
  //   - composited on white before reading, because the sheet is riso-style and nearly every
  //     pixel carries alpha 253. Inside the eye the ink is opaque either way: the served reading is
  //     21-90 on a white ground AND on a dark one, so the theme does not move this row.
  //   - the EXTENT is the eye's own ink run at its column, both ends covered, measured on the
  //     bare frame per eye - not a constant. The constant this replaces (32) was read off the
  //     shipped band and demanded 9 px of cloth beyond the outline; a band drawn to the eye line
  //     failed all nine frames at the top by 4 px (@SDE-App, round five).
  //   - variant C round one (1922c0, the sheet that started this) FAILS both: whites 32.82%, band
  //     139-168 against a needed 121-185 on frame (0,0). The pre-12px sheet (9ff5fd) PASSES both -
  //     it covered the whites; the 12px move was about the lower-rim contact line, which this row
  //     does not claim to judge.
  //   - a synthetic band ending at ay+31 passes whites at 100% and fails EXTENT alone. A band
  //     ending at ay+10 fails both (whites 23.28%).
  //
  // AND THE ROW HAS AN UPPER BOUND NOW, BECAUSE IT DID NOT AND THE OWNER CAUGHT WHAT IT MISSED.
  // "The eye is covered at 99%" is a presence test: a band that swallowed the muzzle, the chin or
  // the whole head passed it, and the sheet that shipped ran from above the eyes to the bottom of
  // the muzzle, over the nose and the mouth (band 106 px tall against a 360 px frame). A coverage
  // row with no upper bound measures presence, not shape, and a shape is what a person sees. So a
  // third assertion per frame holds the NOSE out: the bare frame's light pixels beside and below
  // the nose must still read light on the served frame (>=98%), with a dark-pixel floor proving
  // the window is on the nose. On the rejected sheet that reads 0% on five frames, 36-41% on four.
  //
  // THE CLEAR ROW HAD THE SAME PROXY FAULT FROM THE OTHER SIDE. It counted ANY changed pixel in a
  // +/-20 window, and on the re-rendered reactions sheet the pushed-up band's antialiased lower
  // edge (served luminance fading 65 to 137 over ten rows) reaches rows 154-155 at the anchor
  // columns, where the window starts at 154 and the bare pixel is FUR at luminance ~140. Eight of
  // nine frames read 1-2 px and the row called it "dropped onto the expression". Measured on all
  // eighteen anchors: changed pixels over the expression's INK, zero; the nearest the tail comes
  // to ink is one row (dizzy's spiral). So the row now counts changes only where the bare pixel IS
  // ink (luminance under 110), with a floor on the ink count so the anchor is proven to be on the
  // expression. Mutant: the band's lower twenty rows pasted twenty px lower, onto the eye, fires
  // 14 of 18 (the other four have their ink below where the paste lands). Round two's reactions
  // sheet reads zero, as the old row also found.
  const pg = await browser.newPage();
  // SAME ORIGIN FIRST, OR THE CANVAS IS TAINTED. Reading pixels back from an image drawn onto a
  // canvas is forbidden when the image came from a different origin than the document - and
  // about:blank is a different origin from the app. Navigating to the app and then loading the
  // sheet by a RELATIVE path makes them the same origin, which is the only reason getImageData is
  // allowed to answer. Without this the whole block throws SecurityError and every row is silently
  // not run.
  await pg.goto(BASE, { waitUntil: "domcontentloaded" });
  const sampled = await pg.evaluate(async ({ url, bareUrl, anchors, half, cover, noses, noseHx, noseDown }) => {
    const grab = async (u) => {
      const img = new Image();
      img.src = u;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext("2d");
      // ON WHITE, BOTH MODES: the sheets are riso-style with alpha 253 nearly everywhere and 0
      // outside the fox, and an un-composited alpha-0 pixel carries whatever RGB the encoder left,
      // which can read as ink. Inside the face the composite moves a channel by under 2.
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0);
      return ctx;
    };
    const A = await grab(url), B = await grab(bareUrl);
    const lum = (d, k) => 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
    const out = {};
    for (const [cell, pts] of Object.entries(anchors)) {
      const [r, c] = cell.split(",").map(Number);
      const eyes = pts.map(([ax, ay]) => {
        if (!cover) {
          // CLEAR: a 1 px column through the eye. Count material changes against the bare sheet,
          // but ONLY where the bare pixel is the expression's INK. A change over the fur beside an
          // eye is the band's antialiased tail, and a viewer does not read that as a band on the
          // expression - see the block comment for the 8-of-9 false red this replaced.
          const X = c * 360 + ax, Y = r * 360 + ay - half, N = half * 2 + 1;
          const a = A.getImageData(X, Y, 1, N).data;
          const b = B.getImageData(X, Y, 1, N).data;
          let band = 0, ink = 0;
          for (let k = 0; k < a.length; k += 4) {
            if (lum(b, k) >= 110) continue;
            ink++;
            const d = Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]);
            if (d > 60) band++;
          }
          return { band, ink, total: N };
        }
        // COVER, part one: the eye's OWN light - its glint - is hidden on the served frame.
        //
        // THE DISC THIS REPLACES MEASURED FUR. It counted every light pixel within 30 px of the
        // anchor and required them dark, and 670-810 of those per eye were cheek and muzzle fur
        // against 11-18 pixels of eye: the iris is solid ink, and the only light inside the eye's
        // outline is the glint. So the row mostly demanded that the fur AROUND the eye be covered
        // (L64's shape, pointing the other way), and on the up frame 133 of those fur pixels sat
        // inside the nose window too, where the row below demands they stay light - no sheet
        // could pass both (@SDE-App, round four; @CTO). The eye is found from the inside: ink is
        // luminance under 70 on the bare frame, a flood fill from the window's border walks every
        // non-ink pixel it can reach, and what it cannot reach is the eye's interior - the glint
        // and its rim, 28-45 px per eye, of which the bright core (over 200) is 11-18. Every one
        // of those must read dark on the served frame. Fur is never counted, so the nose window
        // and this one cannot contradict each other, and that is asserted rather than assumed.
        const S = 34, N = S * 2 + 1;
        const a = A.getImageData(c * 360 + ax - S, r * 360 + ay - S, N, N).data;
        const b = B.getImageData(c * 360 + ax - S, r * 360 + ay - S, N, N).data;
        const ink = new Uint8Array(N * N), reached = new Uint8Array(N * N);
        for (let i = 0; i < N * N; i++) ink[i] = lum(b, i * 4) < 70 ? 1 : 0;
        const stack = [];
        for (let i = 0; i < N; i++) for (const j of [i, (N - 1) * N + i, i * N, i * N + N - 1]) if (!ink[j] && !reached[j]) { reached[j] = 1; stack.push(j); }
        while (stack.length) {
          const j = stack.pop(); const y = (j / N) | 0, x = j % N;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
            const q = yy * N + xx; if (!ink[q] && !reached[q]) { reached[q] = 1; stack.push(q); }
          }
        }
        let interior = 0, glint = 0, hidden = 0, overlap = 0;
        const nz = noses[cell];
        for (let j = 0; j < N * N; j++) {
          if (ink[j] || reached[j]) continue;
          interior++;
          const px = ax - S + (j % N), py = ay - S + ((j / N) | 0);
          if (nz && px >= nz[0] - noseHx && px <= nz[0] + noseHx && py >= nz[1] && py <= nz[1] + noseDown) overlap++;
          if (lum(b, j * 4) > 200) { glint++; if (lum(a, j * 4) < 120) hidden++; }
        }
        // COVER, part two: the band's extent at this column, over the whole frame height.
        const W = 7;
        const ca = A.getImageData(c * 360 + ax - 3, r * 360, W, 360).data;
        const cb = B.getImageData(c * 360 + ax - 3, r * 360, W, 360).data;
        let top = -1, bot = -1;
        for (let y = 0; y < 360; y++) {
          let mx = 0;
          for (let x = 0; x < W; x++) { const k = (y * W + x) * 4; mx = Math.max(mx, Math.abs(lum(ca, k) - lum(cb, k))); }
          if (mx > 25) { if (top < 0) top = y; bot = y; }
        }
        // THE EYE'S OWN EXTENT, from the bare frame, not a constant. The contiguous run of ink
        // rows through the anchor at this column is the eye's outline top to bottom (22-23 px
        // above and below the centre on the front frames, less on the turned ones); the band
        // must reach both ends. Not a row past them: a band drawn to the eye line sits one row
        // above the outline, and a requirement one row further is a decoder's rounding from red
        // (L61). A fixed EXTENT_HALF of 32 - a number read off the
        // shipped band, not off the eye - demanded 9 px of cloth beyond the outline and failed
        // every frame of a band drawn to the eye line (@SDE-App, round five).
        const inkRow = (y) => { for (let x = 0; x < W; x++) if (lum(cb, (y * W + x) * 4) < 70) return true; return false; };
        let inkTop = ay, inkBot = ay;
        while (inkTop > 0 && inkRow(inkTop - 1)) inkTop--;
        while (inkBot < 359 && inkRow(inkBot + 1)) inkBot++;
        return { interior, glint, hidden, overlap, top, bot, inkTop, inkBot, needTop: inkTop, needBot: inkBot };
      });
      out[cell] = { eyes, nose: null };
      // THE UPPER BOUND. The two assertions above say the eye is covered; nothing above says the
      // band STOPS, and a band that swallowed the muzzle passed them - which is what shipped, and
      // what the owner saw in one look. This measures the nose's window the way the eye window is
      // measured: the bare frame's LIGHT pixels there (the muzzle's cream beside and below the
      // nose) must still read light on the served frame. "Changed pixels over the nose ink" is not
      // the instrument, for the reason the eye row learned: cloth over near-black ink is a small
      // change (8 to 19 px on the middle row of the shipped sheet, whose band covers the nose
      // entirely). The dark count is the anchor that proves the window landed on the nose.
      if (cover && noses[cell]) {
        const [nx, ny] = noses[cell];
        const NW = noseHx * 2 + 1, NH = noseDown + 1;
        const a = A.getImageData(c * 360 + nx - noseHx, r * 360 + ny, NW, NH).data;
        const b = B.getImageData(c * 360 + nx - noseHx, r * 360 + ny, NW, NH).data;
        let dark = 0, light = 0, kept = 0;
        for (let k = 0; k < a.length; k += 4) {
          const lb = lum(b, k);
          if (lb < 70) dark++;
          else if (lb > 150) { light++; if (lum(a, k) > 120) kept++; }
        }
        out[cell].nose = { dark, light, kept };
      }
    }
    return out;
  }, { url: path, bareUrl: bare, anchors: mustCover ? DIR_ANCHORS : REA_ANCHORS,
       half: REA_EYE_HALF, cover: mustCover,
       noses: mustCover ? NOSE_ANCHORS : {}, noseHx: NOSE_HX, noseDown: NOSE_DOWN });
  await pg.close();

  for (const [cell, { eyes: pts, nose }] of Object.entries(sampled)) {
    pts.forEach((s, k) => {
      if (!mustCover) {
        // The window must contain some of the expression, or "nothing changed over the ink" is
        // true of nothing. Measured: 8 to 41 ink px per window across the eighteen anchors.
        if (s.ink < 5) fails.push(`${path} (${cell}) eye ${k}: only ${s.ink} ink px in the bare eye window (needs >=5) - the anchor is not on the expression, so this row measured nothing`);
        else if (s.band > 0) fails.push(`${path} (${cell}) eye ${k}: ${s.band} of the expression's ${s.ink} ink px changed - the pushed-up band has dropped onto the expression`);
        return;
      }
      // THE ANCHOR MUST BE ON AN EYE'S GLINT, or "every glint pixel is hidden" is true of zero
      // pixels. The twelve measured eyes carry 11-18; under 8 is a window that is not on an eye,
      // or an outline the flood fill leaked through - either way nothing was measured.
      if (s.glint < 8) {
        fails.push(`${path} (${cell}) eye ${k}: only ${s.glint} glint px inside the eye's ink (needs >=8; interior ${s.interior}) - the anchor is not on an eye, so this row measured nothing`);
        return;
      }
      if (s.inkBot - s.inkTop < 20) {
        fails.push(`${path} (${cell}) eye ${k}: the ink run through the anchor at its column is only ${s.inkBot - s.inkTop + 1} rows (${s.inkTop}-${s.inkBot}) - not an eye, so the extent below would be measured against nothing`);
        return;
      }
      if (s.hidden < s.glint) {
        fails.push(`${path} (${cell}) eye ${k}: ${s.glint - s.hidden} of the eye's ${s.glint} glint px still read light on the served frame - the eye is showing`);
      }
      // DISJOINT BY CONSTRUCTION, ASSERTED: nothing this row counts may lie in the nose window,
      // or the two rows demand opposite things of the same pixel and no sheet can pass.
      if (s.overlap > 0) {
        fails.push(`${path} (${cell}) eye ${k}: ${s.overlap} px of the eye's interior lie inside the nose window - the cover row and the nose row contradict each other on this frame; re-aim one`);
      }
      if (s.top < 0 || s.top > s.needTop || s.bot < s.needBot) {
        fails.push(`${path} (${cell}) eye ${k}: the band spans ${s.top}-${s.bot} at the eye's column, needs to reach ${s.needTop}-${s.needBot} (the eye's ink runs ${s.inkTop}-${s.inkBot}) - it ends inside the eye`);
      }
    });
    if (mustCover) {
      // THE NOSE STAYS OUT. Measured on the sheet that shipped and the owner rejected: the muzzle's
      // light pixels beside and below the nose kept 0% of their light on five frames and at most
      // 41% on the rest; every window holds 165+ dark px (the nose) and 497+ light (the cream).
      if (!nose) fails.push(`${path} (${cell}): no nose window was measured - NOSE_ANCHORS has no entry, so the band's lower bound is unchecked here`);
      // The window starts at the nose's centre row, so it holds the blob's lower half: 57 to 260
      // dark px across the nine frames, measured. 40 near-black px beside cream is not fur.
      else if (nose.dark < 40 || nose.light < 300) fails.push(`${path} (${cell}): the nose window holds ${nose.dark} dark and ${nose.light} light px (needs >=40 and >=300) - the anchor is not on the nose, so this row measured nothing`);
      else {
        const kept = (100 * nose.kept) / nose.light;
        if (kept < 98) fails.push(`${path} (${cell}): only ${kept.toFixed(1)}% of the ${nose.light} light px beside and below the nose still read light on the served frame, needs >=98% - the band covers the nose`);
      }
    }
  }
  console.log(`${path}: sha ok, ${gotW}x${gotH}, ${Object.keys(sampled).length} frames sampled for ${mustCover ? "cover, and the nose held out" : "clear"}`);
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
