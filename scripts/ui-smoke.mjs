// Browser smoke: loads the real page and drives a claim the way a person
// does, so a UI regression cannot pass every gate we have. The HTTP smoke
// (e2e-smoke.mjs) proves the API works. Nothing before this proved that the
// page wired to that API works.
//
//   npm run build
//   node scripts/fake-zallet.mjs &                 # PORT=28299 wallet double
//   PORT=28324 node scripts/fake-hosh.mjs &        # tip oracle fixture, see below
//   PORT=28611 node scripts/fake-crosslink.mjs &   # cTAZ node double (#326)
//   FAUCET_SENDER=zallet ZALLET_RPC_URL=http://127.0.0.1:28299/ ZALLET_ACCOUNT=fake-account \
//   ZALLET_ADDRESS=utest1fake ZALLET_MIN_CONF=0 FAUCET_CHALLENGE=pow FAUCET_POW_BITS=12 \
//   RATE_LIMIT_SALT=ui-smoke HOSH_URL=http://127.0.0.1:28324/ TIP_ORACLE_ENDPOINT= \
//   FAUCET_CTAZ_ENABLED=true CROSSLINK_RPC_URL=http://127.0.0.1:28611/ \
//   FAUCET_CTAZ_RPC_SOCKET= PORT=3120 npm start
//
// TWO OF THOSE ARE EMPTY ON PURPOSE AND BOTH COST SOMEBODY AN AFTERNOON.
// TIP_ORACLE_ENDPOINT= stands the oracle's direct leg down: it fetches both references
// every refresh, so left unset it dials the real network, learns a tip ~700,000 blocks
// above this fixture's and reads our node as frozen. FAUCET_CTAZ_RPC_SOCKET= is the
// documented escape hatch for a node reachable over HTTP: the app defaults to the
// production unix socket and deliberately does NOT fall back, so without it the crosslink
// double on 28611 is never reached and every cTAZ assertion fails against a double that is
// answering perfectly. CI sets both (.github/workflows/ci.yml, the ui job); this recipe
// omitted the second one until 2026-09-15, which is exactly the shape of the note below.
//
// The crosslink double is optional: without it the toggle does not render and the cTAZ
// checks announce themselves as SKIPPED rather than passing quietly. A skipped check
// that prints "ok" is worse than no check, so this one says what it did not cover.
//
// BOTH of the other doubles are required, and fake-hosh must be answering BEFORE the app starts. Leave it out
// and the oracle compares the wallet double's tip against the real network, decides
// our node is half a million blocks behind and refuses every claim, so the run fails
// on the LIVE dot and then times out waiting 120s for a "Sent ✓" that cannot come.
// That reads like a UI regression and is not one (#171). This block used to list only
// the wallet double, which is how it cost someone an afternoon.
//   npm i --no-save playwright@1.62.0 && npx playwright install chromium
//   (the same version ci.yml pins, so a local repro cannot diverge from CI)
//   UI_SMOKE_URL=http://localhost:3120 node scripts/ui-smoke.mjs
//
// Playwright is installed with --no-save rather than living in package.json:
// it is a CI-only concern, and keeping it out means `npm ci` stays fast for
// everyone and production installs no browser tooling. Invoked as a plain
// node script for the same reason, no shared package.json entry needed.
import { chromium, devices } from "playwright";

const BASE = (process.env.UI_SMOKE_URL ?? "http://localhost:3120").replace(/\/$/, "");
// THE DESKTOP SIZE THIS SUITE SPEAKS FOR, declared rather than inherited. The contexts below
// passed no viewport, so the desktop pass ran at whatever Playwright defaults to - 1280x720
// today - and the suite reported a clean run while the footer sat 64px below the fold with its
// links unreachable by a pointer. A size nobody chose is a size nobody is testing. Naming it
// changes nothing today and stops it changing silently tomorrow.
const DESKTOP = { width: 1280, height: 720 };
// The second desktop size the footer is checked at, because one size proves one size.
const DESKTOP_ALT = { width: 1366, height: 768 };
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "ok" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
};

// A checksum-valid unified testnet address, from the app's own account API,
// which is also how the UI is supposed to get one.
async function freshAddress() {
  const res = await fetch(`${BASE}/api/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "shielded" }),
  });
  if (!res.ok) throw new Error(`/api/account answered ${res.status}`);
  const body = await res.json();
  const address = body?.account?.address;
  if (!address) throw new Error(`/api/account response has no account.address: ${JSON.stringify(body).slice(0, 120)}`);
  return address;
}

// The visual and accessibility checks the retired QA seat used to eyeball by hand.
// Scripted here so a regression is caught by CI rather than noticed on prod. The
// native rubber-band overscroll bounce is the one thing still not scriptable, so
// it stays a manual check after deploys.
const COLOUR_LIB = `
    const parse = (colour, over) => {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      // An unparseable fillStyle is DISCARDED, leaving the previous value, so a bad
      // colour would otherwise be measured as whatever we happened to paint before it.
      // Two different sentinels disagree exactly when the value did not take.
      ctx.fillStyle = "#000"; ctx.fillStyle = colour; const a = ctx.fillStyle;
      ctx.fillStyle = "#fff"; ctx.fillStyle = colour; const b = ctx.fillStyle;
      if (a !== b) return null;
      // Backdrop first, colour on top, so a semi-transparent token composites the way
      // the browser paints it instead of being read at full strength.
      ctx.clearRect(0, 0, 1, 1);
      if (over) { ctx.fillStyle = over; ctx.fillRect(0, 0, 1, 1); }
      ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((n) => {
        const s = n / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const opaque = (c) => c && !/rgba\\(.*,\\s*0\\)$|transparent/.test(c);
    const bgBehind = (el) => {
      let bg = getComputedStyle(el).backgroundColor;
      while (el && !opaque(bg)) { el = el.parentElement; bg = el ? getComputedStyle(el).backgroundColor : "rgb(255, 255, 255)"; }
      return bg;
    };
    // null when either colour will not parse, so "cannot measure" can be reported as
    // itself rather than arriving as a number that looks like a finding.
    const ratioOf = (fg, el) => {
      const back = parse(bgBehind(el));
      const front = parse(fg, bgBehind(el));
      if (!back || !front) return null;
      const [hi, lo] = [lum(front), lum(back)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
  `;

/**
 * NO LEGACY RULE STILL PAINTS THE REDESIGNED PAGE, read off the BUILT app in both themes.
 *
 * globals.css still ships beside the transcription and styles some of the same selectors. A
 * transcription replaces only what it NAMES (L19), so every property the old rule set and the
 * new one is silent about survives - three of them did: `.tag` kept `text-transform:uppercase`
 * so the design's lower-case status words rendered OK PARKED UNWATCHED, `html` kept the old
 * palette behind the overscroll, and `a:hover` painted every link `--color-accent-800` the
 * moment a pointer touched it.
 *
 * THE FIXES USED TO DEPEND ON LINK ORDER AND NOW DEPEND ON SPECIFICITY, which is the reason
 * this check exists rather than being a nicety. The build emits two CSS chunks; globals landed
 * in one and the transcription in the other, and the fix won because the served page happened
 * to link them in that order. Next does not promise it. Swapping that for specificity alone
 * would trade a fix that depends on link order for one that depends on nobody reintroducing
 * the old rule - so the VALUES are asserted here, and an order flip or a reintroduced rule is
 * red rather than silent.
 *
 * Compared against the retired token RESOLVED ON THE PAGE, not against a hard-coded hex, so
 * this keeps working if the old palette's value is ever edited.
 */
/* THE PAGE'S OWN IDENTITY MUST NOT DEPEND ON WHICH CSS CHUNK THE BUNDLER EMITS FIRST.
 *
 * This is the guard the redesign has been missing since #562, and it is the finding that
 * outranked the five leaks it was found alongside. Next emits the legacy sheet and the
 * transcription as TWO chunks, and the served page happens to link them in the order that
 * makes the redesign win. Nothing promises that order. Both sheets set `body` background,
 * colour and font at (0,0,1) - `redesign-shell.css` against `globals.css:73` - and both style
 * the theme toggle at (0,1,0), `.iconbtn` against `.theme-toggle`, on the same button.
 *
 * Measured before the fix, by reordering the <link> tags on the built page: 100 of 118 nodes
 * repainted, 234 property deltas in paper and 165 in ink. Font family Segoe UI Variable to
 * Archivo, background, colour, line-height, the toggle's border. The five leaks that #575 is
 * named for were the VISIBLE part of that; the rest was silent and the suite was 146/0
 * through all of it.
 *
 * So this does not pin a list of values. It asserts the PROPERTY: flip the chunk order on the
 * real built page and nothing may move. That is true of whatever the design grows next, where
 * a list of values would go stale the first time a colour changed.
 *
 * WHY IT CANNOT PASS VACUOUSLY. A page with one stylesheet, or a flip that did not take, or a
 * body that rendered nothing, would all report "no deltas" and go green. So the flip is
 * verified by reading the href order back, and the node count carries a floor. */
async function checkChunkOrderIdentity(browser) {
  const PROPS = ["fontFamily", "backgroundColor", "color", "lineHeight", "fontSize", "fontWeight", "borderColor", "borderRadius", "letterSpacing"];
  for (const theme of ["paper", "ink"]) {
    const c = await browser.newContext({ viewport: DESKTOP });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.evaluate((t) => {
      try { localStorage.setItem("zfaucet_theme", t); } catch {}
      document.documentElement.dataset.theme = t;
    }, theme);
    await p.waitForTimeout(300);

    const order = () => p.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href));
    const snap = () => p.evaluate((PROPS) => {
      const out = [];
      document.querySelectorAll("body, body *").forEach((el) => {
        const cs = getComputedStyle(el);
        out.push({ tag: el.tagName.toLowerCase(), cls: (el.className || "").toString().slice(0, 30), v: PROPS.map((k) => cs[k]) });
      });
      return out;
    }, PROPS);

    const linksBefore = await order();
    const before = await snap();
    await p.evaluate(() => {
      const ls = [...document.querySelectorAll('link[rel="stylesheet"]')];
      if (ls.length < 2) return;
      ls[0].parentNode.insertBefore(ls[ls.length - 1], ls[0]);   // last chunk linked first
    });
    await p.waitForTimeout(400);
    const linksAfter = await order();
    const after = await snap();

    const flipped = linksBefore.length >= 2 && linksBefore.join() !== linksAfter.join();
    let moved = 0, deltas = 0, first = "";
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      const a = before[i], b2 = after[i];
      if (a.v.join("|") === b2.v.join("|")) continue;
      moved++;
      for (let k = 0; k < a.v.length; k++) {
        if (a.v[k] === b2.v[k]) continue;
        deltas++;
        if (!first) first = `<${a.tag}${a.cls ? " ." + a.cls.split(" ")[0] : ""}> ${PROPS[k]} ${a.v[k]} -> ${b2.v[k]}`;
      }
    }
    ok(`${theme}: the page is identical with the CSS chunks linked in the other order`,
      flipped && before.length >= 50 && moved === 0,
      !flipped ? `the flip did not take: ${linksBefore.length} stylesheet(s)`
        : before.length < 50 ? `only ${before.length} nodes rendered, too few to judge`
        : `${moved} of ${before.length} nodes moved, ${deltas} deltas; first: ${first}`);
    await c.close();
  }
}

async function checkLegacyPalette(browser) {
  for (const theme of ["paper", "ink"]) {
    const c = await browser.newContext({ viewport: DESKTOP });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.evaluate((t) => {
      try { localStorage.setItem("zfaucet_theme", t); } catch {}
      document.documentElement.dataset.theme = t;
    }, theme);
    await p.waitForTimeout(300);

    // The retired accent, resolved through the page so the comparison is rgb against rgb.
    const retired = await p.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-accent-800)";
      document.body.appendChild(probe);
      const v = getComputedStyle(probe).color;
      probe.remove();
      return v;
    });

    // HOVERED ON A LINK THIS CHECK INSERTS, and the first version measured three links that
    // could not show the defect. It hovered `.ftr nav a`, which the footer's own (0,2,1) hover
    // rule already protects; `.seg button`, which is a button, so `a:hover` never matched it at
    // all; and the first `main a`, which sits inside `.about-strip-line` whose (0,1,1) rule in
    // globals sits AFTER `a:hover` and wins at any order. So a real link-order flip left the
    // row green, and the 144/2 in the body came from a mutant that appends the retired rule
    // last - something a flip cannot produce. Found by the CTO's red-team.
    //
    // A bare <a> in the stage has nothing protecting it, which is the surface the rule is
    // about. Fixed-position so it is always reachable by a pointer, and still a DESCENDANT of
    // .stage, which is what `.stage a:hover` keys on.
    const probeColour = await (async () => {
      await p.evaluate(() => {
        const stage = document.querySelector(".stage") ?? document.body;
        const a = document.createElement("a");
        a.id = "hover-probe";
        a.href = "/terms";
        a.textContent = "probe";
        a.style.cssText = "position:fixed;top:8px;left:8px;z-index:99999;padding:4px";
        stage.appendChild(a);
      });
      await p.hover("#hover-probe").catch(() => {});
      await p.waitForTimeout(120);
      return p.locator("#hover-probe").evaluate((el) => getComputedStyle(el).color);
    })();
    ok(`${theme}: a bare link in the stage does not hover to the retired palette`,
      !!probeColour && probeColour !== retired,
      `retired ${retired}; probe hovered to ${probeColour}`);

    // The other two need no pointer.
    //
    // THE TAG IS MEASURED ON AN ELEMENT THIS CHECK INSERTS, and the first version of it was
    // vacuous for exactly the reason worth recording. It read the first `.tag` on the page and
    // passed when there was none - and on a fresh landing page there IS none, because every
    // `.tag` in the claim card is behind a phase or a receipt. So it reported
    // "text-transform no tag" and went green having measured nothing, which is the shape I
    // have blocked other people's checks for twice tonight.
    //
    // Inserting one into the stage measures the CASCADE, which is the property: does any rule
    // still upper-case `.tag` inside this page. It is true or false whether or not the current
    // phase happens to render one, and it cannot pass by absence.
    const rest = await p.evaluate(() => {
      const stage = document.querySelector(".stage") ?? document.body;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "probe";
      stage.appendChild(tag);
      const tagCase = getComputedStyle(tag).textTransform;
      tag.remove();
      const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
      const probe = document.createElement("span");
      probe.style.color = "var(--page)";
      document.body.appendChild(probe);
      const page = getComputedStyle(probe).color;
      probe.remove();
      return { tagCase, htmlBg, page };
    });
    ok(`${theme}: the design's tags are not upper-cased by the legacy sheet`,
      rest.tagCase === "none",
      `text-transform ${rest.tagCase}`);
    ok(`${theme}: the page's root paints the design's background, not the old one`,
      rest.htmlBg === rest.page, `html ${rest.htmlBg} against --page ${rest.page}`);

    // SELECTING TEXT DOES NOT HIGHLIGHT IT IN THE RETIRED PALETTE. globals.css:101 paints
    // ::selection with --color-accent and the spec defines no selection colour at all, so it
    // is a property the transcription was silent about and inherited whether it meant to or
    // not (L20). Read off a real element's ::selection, not from the rule text.
    const sel = await p.evaluate(() => {
      // A DESCENDANT, not `.stage` itself. `.stage ::selection` matches elements INSIDE the
      // stage, so reading it off `.stage` measures only globals' rule and reports the
      // retired mix whether the fix is there or not - which is what it did.
      const el = document.querySelector(".stage h1, .stage p, .stage a") ?? document.body;
      const got = getComputedStyle(el, "::selection").backgroundColor;
      // THE RETIRED VALUE AS THE OLD RULE WOULD PRODUCE IT, mix and all. Comparing the
      // selection's 30% mix against the SOLID retired accent was my first version, and the
      // two can never be equal, so it passed with the fix deleted - measured, 146/0.
      const probe = document.createElement("span");
      probe.style.backgroundColor = "color-mix(in srgb, var(--color-accent) 30%, transparent)";
      document.body.appendChild(probe);
      const retired = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { got, retired };
    });
    ok(`${theme}: selecting text does not highlight it in the retired accent`,
      sel.got !== sel.retired, `selection ${sel.got}, retired accent ${sel.retired}`);
    await c.close();
  }
}

/**
 * THE FOOTER IS REACHABLE BY A POINTER, at two desktop sizes.
 *
 * The design clamps the page to one screen (`.stage` height:100dvh, and above 56rem
 * `overflow:hidden`). Over the pre-redesign content, which is taller than a screen, that cut
 * the footer by 30 to 93px and left Donate TAZ, Terms and GitHub unreachable - six wheel
 * events moved scrollTop from 0 to 0 - while this suite reported a clean run. It reported
 * clean because everything here asked whether text was PRESENT, and `textContent` reads a
 * clipped element exactly like a visible one.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT "the document fits the viewport". The ruling that
 * dropped the clamp makes the document TALLER than the viewport over this content - measured
 * 787px in 720px and 803px in 768px - so "fits" and "clamp dropped" cannot both be true in
 * this slice. Fitting is the FINISHED design's property and arrives with the content designed
 * for it, enforced per slice by I1's fit check. The property that was actually broken, and
 * the one a visitor feels, is REACHABILITY: the page scrolls, and every footer link can be
 * clicked once you get there. Clipped-and-unscrollable fails this; tall-and-scrollable passes.
 *
 * `elementFromPoint` at the link's centre is what makes it real - a link that is present, in
 * the box model, and covered or clipped fails, which is what "pointer-unreachable" meant to
 * whoever wanted /terms. Production has `maintenanceAddress` set and carries a fourth link,
 * so whatever links the footer holds are the ones checked and the count is not hard-coded.
 */
/* THE CARD'S OWN EDGE, measured against whatever is inside it.
 *
 * The claim card shipped to production with the fox carrying NO inner padding: every text node
 * sat 1px from its left border, inside the rounded corner, and the "1" of "189 drips served"
 * was clipped by the radius at 1440x900. It survived three review rounds because every parity
 * probe measured a DESIGN element against the snapshot, and this is CURRENT content inside a
 * design container - a thing the snapshot never draws, so no probe had any opinion about it.
 *
 * So this asserts a property of the CARD rather than of its contents: whatever fills it clears
 * its own edge. S2b swaps the whole block for the real panels and this check still applies.
 *
 * Both edges, not just the left the screenshot showed, because one rule sets both and a fix
 * that only reached one side would read as green here and clipped on screen.
 *
 * THE COUNT FLOOR IS THE POINT. A card that rendered no text - a phase change, a failed status,
 * a renamed class - would have nothing to measure and would report a clean run, which is the
 * shape of every vacuous assertion this suite has had to fix. Fewer than six text nodes is a
 * red line, not a quiet pass. */
async function checkCardInnerPadding(browser) {
  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const c = await browser.newContext({ viewport: vp });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.waitForSelector(".card.claim", { timeout: 15_000 }).catch(() => {});
    const r = await p.evaluate(() => {
      const card = document.querySelector(".card.claim");
      if (!card) return { measured: 0, worst: null, missing: true };
      const cr = card.getBoundingClientRect();
      const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      let n, measured = 0, worst = null;
      while ((n = walk.nextNode())) {
        const t = (n.textContent || "").trim();
        if (!t) continue;
        const rg = document.createRange();
        rg.selectNodeContents(n);
        const b = rg.getBoundingClientRect();
        if (!b.width || !b.height) continue;          // not rendered: nothing to clip
        measured++;
        const gap = Math.min(b.left - cr.left, cr.right - b.right);
        if (!worst || gap < worst.gap) worst = { gap: Math.round(gap * 10) / 10, text: t.slice(0, 40) };
      }
      return { measured, worst, missing: false };
    });
    const detail = r.missing ? "no .card.claim on the page"
      : `${r.measured} text nodes, worst ${r.worst ? r.worst.gap : "-"}px on "${r.worst ? r.worst.text : "-"}"`;
    ok(`${vp.width}x${vp.height}: every text node in the claim card clears the card's own edge by 8px`,
      !r.missing && r.measured >= 6 && !!r.worst && r.worst.gap >= 8, detail);
    await c.close();
  }
}

async function checkFooterReachable(browser) {
  // THE LOOP'S OWN COVERAGE IS PINNED. Cutting DESKTOP_ALT out of it left the suite at
  // 132 ok, 0 fail, exit 0 - half the viewports and a clean green, which is the array-pin
  // hole I blocked #563 for arriving in my own file. The sizes actually visited are
  // asserted, so dropping one is a red line rather than a quieter suite.
  const visited = [];
  for (const vp of [DESKTOP, DESKTOP_ALT]) {
    visited.push(`${vp.width}x${vp.height}`);
    const c = await browser.newContext({ viewport: vp });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.waitForTimeout(400);
    const label = `${vp.width}x${vp.height}`;

    // NOTHING BETWEEN THE FOOTER AND THE DOCUMENT CLIPS WHAT IT CANNOT SCROLL.
    //
    // This is the CAUSE rather than a symptom, and the difference cost me a measurement. My
    // first version asked whether the document could be scrolled to its bottom. With the
    // clamp in place `documentElement.scrollHeight` EQUALS the viewport - `.stage` clips, so
    // the document itself never overflows - and the check took its "the page fits, nothing to
    // scroll" branch and passed. It passed over the exact defect it was written for.
    //
    // Worse, whether the clamp actually cuts anything depends on how tall the content happens
    // to be, which moves with phase, data and font metrics: the red-team measured a 30 to 93px
    // cut, and on my fixture stack the same CSS fits 720px exactly and cuts nothing. A check
    // that only fires in the states where the damage is already visible is not a check on the
    // clamp, it is a check on today's content (L1).
    //
    // So: walk from the footer to the document and fail on any ancestor that hides overflow
    // while having more content than box. That is "clipped with no way to reach it", and it is
    // true or false regardless of whether this run's content happens to trip it.
    const clip = await p.evaluate(() => {
      const found = [];
      for (let e = document.querySelector(".ftr"); e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        const hidden = cs.overflowY === "hidden" || cs.overflowY === "clip";
        const over = e.scrollHeight - e.clientHeight;
        if (hidden && over > 1) {
          found.push(`${e.tagName.toLowerCase()}${e.className ? "." + String(e.className).split(" ")[0] : ""} hides ${over}px`);
        }
      }
      return found;
    });
    ok(`${label}: nothing between the footer and the document clips content it cannot scroll`,
      clip.length === 0, clip.join("; ") || "no clipping ancestor");

    // AND THE STAGE DOES NOT SWALLOW A WHEEL. The pair above says the footer is reachable and
    // nothing clips it; this says the thing a visitor's fingers do actually moves the page.
    // A clamped `.stage` leaves scrollTop pinned at 0 through any number of wheel events,
    // which is what "six wheel events moved scrollTop from 0 to 0" meant in the original
    // finding.
    // TWO THINGS WENT WRONG HERE AND BOTH WERE MINE.
    //
    // The old version escaped on `documentElement.scrollHeight - innerHeight <= 0` and reported
    // "the page fits, so there was nothing to scroll". Under the clamp the document NEVER
    // overflows - `.stage` clips the overflow instead of pushing the document taller - so on
    // the exact defect this check is named for it measured nothing and went green. And it
    // dispatched synthetic WheelEvents, which are untrusted and scroll nothing at all, so the
    // "six wheel events" it claimed to perform were six no-ops.
    //
    // The property that a clamped page actually breaks is not "the document is taller than the
    // viewport". It is that `.stage` is HIDING content a pointer cannot reveal: overflow
    // hidden with more content in it than fits. That is true whether or not the document
    // overflows, and it is what leaves the footer links unreachable.
    // MEASURED WITH A TALL PROBE THIS CHECK INSERTS, and it took three tries to get here.
    //
    // First it escaped on "the document does not overflow", which under the clamp is always
    // true - the stage clips instead of pushing the document taller - so it went green on the
    // exact defect. Then it read `scrollHeight - clientHeight`, which is 0 even while content
    // is clipped, because `.stage` carries `container: stage / size` and size containment makes
    // scrollHeight equal clientHeight. Then it walked descendant rectangles, and the furthest
    // was `.comp`, which is sized to the stage.
    //
    // The third answer is the one the red-team had already given me: THE SHIPPED PAGE FITS ONE
    // SCREEN TODAY, so restoring the clamp clips nothing and no passive measurement of the real
    // content can go red. A check that only fails when the content happens to be too tall is a
    // check that fails on someone else's future commit, not on this one.
    //
    // So it asks the question actively, the way the tag and hover checks do: put something in
    // the stage that IS taller than a screen, and see whether the page can still reach it. With
    // the stage as it ships the box grows and the document scrolls; under the clamp the probe
    // is swallowed and a wheel cannot get to it. That is true whatever today's content weighs.
    const stage = await p.evaluate(() => {
      const el = document.querySelector(".stage");
      if (!el) return null;
      const cs = getComputedStyle(el);
      const host = el.querySelector(".comp") ?? el;
      const probe = document.createElement("div");
      probe.id = "tall-probe";
      probe.style.cssText = "height:1200px;width:1px;flex:none";
      host.appendChild(probe);
      const r = el.getBoundingClientRect();
      const buried = Math.round(probe.getBoundingClientRect().bottom - (r.top + el.clientHeight));
      const inserted = !!probe.getBoundingClientRect().height;
      probe.remove();
      // AFTER the probe is gone. Measured with it still in, this reported the page as 1109px
      // past the fold and turned the wheel assertion below into a false red against a document
      // that no longer overflowed - a probe of mine poisoning the next check.
      const docOver = Math.round(document.documentElement.scrollHeight - innerHeight);
      return { overflowY: cs.overflowY, buried, docOver, inserted };
    });
    ok(`${label}: content taller than the viewport is not swallowed by the stage`,
      !!stage && stage.inserted && stage.buried <= 1,
      !stage ? "no .stage on the page"
        : !stage.inserted ? "the probe did not render, so nothing was measured"
        : `overflow-y ${stage.overflowY}, a 1200px probe sits ${stage.buried}px past the stage's own box`);

    // And a REAL wheel, through the browser rather than a dispatched event, on the pages that
    // are taller than the viewport. This one can still be inapplicable - it says so rather
    // than claiming a pass - because the check above is what carries the clamped case.
    const beforeTop = await p.evaluate(() => document.documentElement.scrollTop);
    await p.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
    await p.mouse.wheel(0, 600);
    await p.waitForTimeout(200);
    const movedBy = await p.evaluate((b) => document.documentElement.scrollTop - b, beforeTop);
    if (stage && stage.docOver > 0) {
      ok(`${label}: a real wheel scrolls the page when it is taller than the viewport`,
        movedBy > 0, `${stage.docOver}px past the fold and scrollTop moved ${movedBy}`);
    } else {
      console.log(`  --   ${label}: the document does not overflow, so a wheel has nothing to move (the clip check above is what covers this)`);
    }

    // REACHED THE WAY A VISITOR REACHES IT, not the way a script can. This used
    // `scrollIntoView({block:"end"})`, and the CTO's red-team found that it scrolls an
    // `overflow:hidden` box PROGRAMMATICALLY where a wheel cannot - so on the clamped page it
    // reported every link `in/hit` while only the sibling clip assertion went red. An
    // assertion written to close an L1 that could not fail on its own defect, carried by its
    // neighbour. `window.scrollTo` moves the document and is refused by a clipped box exactly
    // as a wheel is.
    const r = await p.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const links = [...document.querySelectorAll(".ftr nav a")].map((a) => {
        const b = a.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return {
          t: a.textContent.trim(),
          inView: b.top >= 0 && b.bottom <= innerHeight && b.width > 0,
          hit: !!(hit && (hit === a || a.contains(hit))),
        };
      });
      return { links };
    });
    const bad = r.links.filter((l) => !l.inView || !l.hit);
    ok(`${label}: every footer link can be reached and clicked`,
      r.links.length > 0 && bad.length === 0,
      r.links.length === 0 ? "no footer links found, so nothing was measured"
        : r.links.map((l) => `${l.t}:${l.inView ? "in" : "OUT"}/${l.hit ? "hit" : "BLOCKED"}`).join("  "));
    await c.close();
  }
  ok("the footer is checked at both declared desktop sizes",
    visited.join(",") === `${DESKTOP.width}x${DESKTOP.height},${DESKTOP_ALT.width}x${DESKTOP_ALT.height}`,
    visited.join(", ") || "no viewports visited");
}

async function checkAppearance(page) {
  // The masthead mark, same identity as the favicon. aria-hidden by design, so
  // assert its presence, not an accessible name.
  ok("the masthead mark renders", await page.getByTestId("brand-mark").isVisible());

  // THE TRANSITIONAL MEASURE, COUNTED SO IT CANNOT OUTLIVE ITS PURPOSE QUIETLY.
  //
  // `.view.legacy-measure` caps a view's content at the 760px the pre-redesign markup was
  // written for. The redesign's views are full width because the cards they will hold are,
  // so every slice that transcribes a view must take the class off with it - and a class
  // left behind would not fail anything, it would just quietly squeeze the new design into
  // two thirds of the page. Nobody notices a layout that merely looks narrow.
  //
  // So the COUNT is pinned, and the number comes down as slices land: 4 at S1, 3 once S2
  // transcribes the claim view, and 0 after S5. Changing it is a line in the diff and a
  // decision someone made, which is the whole point.
  const LEGACY_VIEWS = 3;   // S2a transcribed the claim view and took its cap off
  const legacy = await page.locator(".view.legacy-measure").count();
  ok(`exactly ${LEGACY_VIEWS} views still carry the transitional 760px measure`,
    legacy === LEGACY_VIEWS,
    `${legacy} found; if a slice just transcribed a view, drop this number with it`);

  // THE PRIVACY SENTENCE, PINNED WORD FOR WORD, because it is a factual claim about what
  // this service keeps and the exact words were argued over. The preview said "Addresses and
  // IPs are never logged"; I blocked on it because it is defensible about RAW values and
  // misleading about the salted fingerprints the rate limiter persists until PURGE_SQL drops
  // them, and the CTO ruled the stronger, truer form. A sentence like this drifting back
  // toward the comfortable version is exactly the change nobody notices in a diff.
  ok("the footer states what is kept, in the words that survived review",
    (await page.textContent("body"))?.includes(
      "No accounts, no cookies, no trackers. Addresses and IPs are hashed, never stored raw.") === true,
    "the exact sentence is not on the page");

  // AND THE WIDTH THE TRANSITIONAL CAP IS THERE TO HOLD, measured rather than inferred from
  // the class being present (SDE-Infra's finding on review). The count above catches the class
  // being REMOVED early; it cannot catch the cap silently failing to apply - a changed
  // selector, a specificity fight, a later rule setting width on the same children. Those
  // leave the class in place and the content at full width, which is the 802px regression this
  // exists to prevent, and nothing else in this suite can see it.
  //
  // MEASURED INSIDE ONE VIEW, AND A VISIBLE ONE. The first version of this took the first
  // `.view.legacy-measure` in the DOM and the first `input.input` on the page, which were the
  // same view only while the claim view was still capped. S2a transcribed the claim view and
  // took its cap off, so the selector began returning a HIDDEN section - width 0 - and
  // comparing it against an input in a different, visible view. It failed loudly, which is the
  // good case, but for one commit it was measuring two unrelated things. The cap applies to
  // `.view.legacy-measure > *`, so that is what is measured, in the view it belongs to.
  await showView(page, "status");
  const measure = await page.evaluate(() => {
    const view = document.querySelector(".view.legacy-measure:not([hidden])");
    const child = view && view.firstElementChild;
    if (!view || !child) return { missing: true };
    return { view: Math.round(view.getBoundingClientRect().width), child: Math.round(child.getBoundingClientRect().width) };
  });
  ok("the untranscribed content is still capped at its old measure inside a full-width view",
    !measure.missing && measure.view > 900 && measure.child <= 760,
    measure.missing ? "no visible .view.legacy-measure with content, so nothing was measured"
      : `view ${measure.view}px, its capped content ${measure.child}px (cap 760)`);
  await showView(page, "claim");

  // THE FOX FOLLOWS ITS COLUMN, and nothing else checks this. page-mascot writes
  // `width: size, height: size` INLINE on its root (dist/mascot.js:149), and an inline
  // declaration beats any normal author rule, so the spec's `.mascot-riso { width: 100% }`
  // loses and the fox sits at its fixed 300px whatever its column does. The override that
  // fixes it carries `!important`, is NOT in the frozen snapshot (MASCOT.md asks for it and
  // describes it as already there), and is exactly the kind of load-bearing line that gets
  // "tidied" by someone who sees an !important and assumes it is cargo. Measured: 244px with
  // it at 1440x900, 300px without.
  //
  // THE ASSERTION IS AGAINST THE COLUMN, NOT A PIXEL NUMBER, and the first version of it was
  // wrong in a way worth recording. It asserted `width < 300`, the component's inline size.
  // That passed with the override REMOVED, because at this suite's 1280-wide viewport the
  // non-important `max-width` still caps the fox at ~281px - under 300, over its ~243px
  // column, overflowing it. A threshold that the broken state also satisfies is not a test
  // (L1). What "follows its column" actually means is that the fox is no wider than the
  // figure it sits in, so that is what is measured.
  const fox = await page.evaluate(() => {
    const el = document.querySelector(".mascot-riso");
    const col = el && el.closest(".hero-mascot");
    if (!el || !col) return { missing: true };
    return {
      w: Math.round(el.getBoundingClientRect().width),
      col: Math.round(col.getBoundingClientRect().width),
      inline: el.style.width,
    };
  });
  ok("the mascot follows its column instead of the size the component sets inline",
    !fox.missing && fox.w > 0 && fox.w <= fox.col + 1,
    fox.missing ? "no .mascot-riso inside a .hero-mascot, so nothing was measured"
      : `rendered ${fox.w}px in a ${fox.col}px column, inline ${fox.inline || "(none)"}`);

  // The LIVE dot paints the state, not a fixed colour: --color-live only when the
  // faucet is serviceable. Compare the dot's resolved background to the token
  // itself, not a hardcoded rgb, so a theme edit cannot make this assertion lie.
  const [dotBg, liveToken] = await page.evaluate(() => {
    const dot = document.querySelector("[data-testid=status-dot]");
    // No dot is its own failure, not a theme mismatch: falling back to body here
    // resolves the :root default and would report a misleading wrong-theme colour
    // for a problem that is actually a missing dot.
    if (!dot) return ["no dot", "no dot to probe"];
    // Resolve the token in the DOT's own context: the theme tokens are scoped to
    // the .app wrapper, so a body-level probe reads the :root default and would
    // compare the dot against the wrong theme's value.
    const probe = document.createElement("span");
    probe.style.color = "var(--color-live)";
    dot.parentElement.appendChild(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(dot).backgroundColor, token];
  });
  ok("the LIVE dot carries the --color-live state colour", dotBg === liveToken, `${dotBg} vs ${liveToken}`);

  // Reduced-motion, BOTH directions. `reduce == halted` alone would also pass if
  // the animation had simply stopped existing, a live risk since the dot was
  // refactored, so the pair pins it: animated by default, none under reduce. The
  // global `* { animation: none !important }` beats the inline style here, which
  // is the exact cascade fact this proves is still working.
  const dotAnim = () =>
    page.evaluate(() => {
      const dot = document.querySelector("[data-testid=status-dot]");
      return dot ? getComputedStyle(dot).animationName : "no dot";
    });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  ok("the dot animates by default", (await dotAnim()) === "pulse");
  await page.emulateMedia({ reducedMotion: "reduce" });
  ok("reduced-motion halts the dot", (await dotAnim()) === "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Text contrast, worst readable link, in BOTH themes. Two corrections earned
  // by review: (1) the FIRST anchor is the textless logo, whose colour is the
  // colour of text that does not exist, so only links with real text and a real
  // box count, and we take the WORST rather than the first; (2) --color-accent-text
  // is per-theme (#96/#99) and one value is unusable in the other theme, so the
  // theme the page does not render at test time is exactly the one worth checking.
  // Colour maths for both contrast checks below, injected once.
  //
  // EVERY COLOUR GOES THROUGH THE BROWSER'S OWN PARSER, never a regex. The tokens in
  // this stylesheet are `color-mix()`, which computes to `color(srgb 0..1)` in one
  // theme and `oklab(...)` in the other, and a parser assuming `rgb(0..255)` silently
  // divides by 255 and returns a confident wrong number: reviewing #297 that produced
  // 1.10:1 for an icon that is plainly legible. Painting to a 1x1 canvas and reading
  // the pixel back means whatever CSS invents next is already handled.


  const worstReadableLink = () =>
    page.evaluate(`(() => {
      ${COLOUR_LIB}
      const links = [...document.querySelectorAll("a")].filter((a) => {
        const r = a.getBoundingClientRect();
        return a.textContent.trim() && r.width > 0 && r.height > 0;
      });
      if (!links.length) return null;
      let worst = null;
      for (const a of links) {
        const ratio = ratioOf(getComputedStyle(a).color, a);
        if (ratio == null) return { unparseable: a.textContent.trim().slice(0, 24) };
        if (!worst || ratio < worst.ratio) worst = { ratio, link: a.textContent.trim().slice(0, 24) };
      }
      return worst;
    })()`);

  // Icon-only controls: the theme toggle and the source link (#297, #300). Neither has
  // text, so the check above skips both by construction, and they are precisely the
  // controls with nothing to fall back on if their colour drifts.
  //
  // 3:1, not 4.5:1. WCAG 1.4.11 non-text contrast governs "visual information required
  // to identify user interface components", and holding these to the text threshold
  // would fail controls that are actually compliant, which is a false alarm rather
  // than a finding.
  //
  // Gated on the GLYPH, which is what identifies the control, measured through the
  // element's own `color` because both icons paint with `currentColor`. The container
  // border is measured and reported but NOT gated, and the reason is 1.4.11's own
  // scope rather than a preference: the requirement covers visual information required
  // to IDENTIFY a component, the glyph does that on its own, and a box edge is a
  // boundary rather than identifying information.
  //
  // The tempting reason, that the border uses the site-wide `--color-divider` token so
  // this is not the place to litigate it, is App's catch and it proves too much: it
  // would excuse never gating anything drawn with a shared token, and a shared token
  // that fails is worse than a local one because it fails everywhere at once. If the
  // divider is ever worth gating, it wants its own named check where the site-wide
  // decision is argued out loud, not silence inside a masthead check.
  const worstIconControl = () =>
    page.evaluate(`(() => {
      ${COLOUR_LIB}
      const controls = [...document.querySelectorAll("a, button")].filter((el) => {
        const r = el.getBoundingClientRect();
        return !el.textContent.trim() && el.querySelector("svg") && r.width > 0 && r.height > 0;
      });
      if (!controls.length) return null;
      let worst = null;
      const measured = [];
      for (const el of controls) {
        const name = el.getAttribute("aria-label") || el.tagName.toLowerCase();
        const cs = getComputedStyle(el);
        const glyph = ratioOf(cs.color, el);
        const border = ratioOf(cs.borderTopColor, el);
        if (glyph == null) return { unparseable: name };
        measured.push(name);
        if (!worst || glyph < worst.ratio) worst = { ratio: glyph, border, control: name.slice(0, 34) };
      }
      // The two controls #300 exists for, named so the check cannot quietly re-target.
      return { ...worst, measured, sawSource: measured.some((n) => /GitHub/i.test(n)), sawToggle: measured.some((n) => /Switch to/i.test(n)) };
    })()`);
  // Toggle to a target theme via the real footer control and wait for it to apply.
  //
  // The class landing is NOT the colours landing. `.theme-toggle` carries
  // `transition: color .12s ease`, so a measurement taken the moment the class flips
  // reads a colour partway between the two themes. Building this check I measured
  // exactly that and got 1.00:1 on both masthead icons, which looks precisely like a
  // real contrast failure and is an artifact of when I looked. So settle the colours
  // before returning: poll the toggle's computed colour until two consecutive reads
  // agree. A fixed sleep would be a guess about a duration the stylesheet is free to
  // change.

  // The FOCUS RING, which is a state indicator and so is covered by the same WCAG 1.4.11
  // that #306 applied to the controls themselves (#307). Nothing read it before: the ring
  // is how a keyboard user knows where they are, and `--color-accent` is one value while
  // the surfaces behind it are per-theme, so it can pass on one background and fail on
  // another with nothing to say so.
  //
  // DRIVEN WITH REAL TAB PRESSES rather than el.focus(). `:focus-visible` is the state
  // under test and it is exactly the state that distinguishes keyboard focus from a
  // click, so synthesising it would be measuring a different thing. Tabbing also
  // enumerates the REACHABLE set, which is what "these controls became unreachable" has
  // to be measured against.
  //
  // THE BACKDROP IS THE ANCESTOR, NOT THE ELEMENT. `outline-offset: 2px` draws the ring
  // OUTSIDE the border box, so on a filled control the ring sits on whatever the control
  // sits on rather than on the control. Measuring against the element's own background
  // would be most wrong for the primary button, which is the accent-filled one and so the
  // likeliest to fail.
  const worstFocusRing = () =>
    page.evaluate(`(() => {
      ${COLOUR_LIB}
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const cs = getComputedStyle(el);
      // The accessible name, which is what a screen reader announces and what a reader
      // of this output will recognise. An input's name comes from its <label>, so
      // falling back to the tag name reported the claim field as "input" and made the
      // reachability anchor below unable to name the thing it was looking for.
      const name = (el.getAttribute("aria-label")
        || el.labels?.[0]?.textContent?.trim()
        || el.textContent.trim()
        // A link wrapping only an image takes its name from that image's alt, which is
        // how the footer mark is announced. Without this it reported as a bare "a" and
        // looked like an unnamed focusable control, which is a real defect and would
        // have been a false one to report.
        || el.querySelector("img[alt]")?.getAttribute("alt")?.trim()
        || el.getAttribute("placeholder")
        || el.tagName.toLowerCase()).slice(0, 40);
      // No ring at all is its own failure, not a ratio: a keyboard user gets nothing.
      if (cs.outlineStyle === "none" || parseFloat(cs.outlineWidth) === 0) {
        return { name, none: true };
      }
      return { name, ratio: ratioOf(cs.outlineColor, el.parentElement ?? el), width: parseFloat(cs.outlineWidth) };
    })()`);

  // Walk the whole tab order once and keep the worst ring. Capped rather than looping
  // until it wraps, because a focus trap would otherwise hang the suite rather than
  // failing it, and a hang reads as infrastructure trouble instead of as a finding.
  const sweepFocusRings = async () => {
    await page.evaluate(() => document.activeElement?.blur?.());
    const seen = [];
    let worst = null, ringless = null;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const r = await worstFocusRing();
      if (!r) continue;
      if (seen.includes(r.name)) break; // wrapped
      seen.push(r.name);
      if (r.none) { ringless = ringless ?? r.name; continue; }
      if (r.ratio != null && (!worst || r.ratio < worst.ratio)) worst = r;
    }
    return { worst, ringless, seen };
  };
  const setTheme = async (want) => {
    const isInk = () => page.evaluate(() => document.querySelector(".app")?.classList.contains("ink") ?? false);
    if ((want === "ink") !== (await isInk())) await page.getByRole("button", { name: /Switch to/ }).click();
    await page.waitForFunction((w) => (document.querySelector(".app")?.classList.contains("ink") ?? false) === (w === "ink"), want);
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-testid=theme-toggle]");
      if (!el) return true; // no toggle is the other checks' problem, not this wait's
      const now = getComputedStyle(el).color;
      const settled = window.__uiSmokeLastColour === now;
      window.__uiSmokeLastColour = now;
      return settled;
    }, null, { polling: 60, timeout: 5_000 });
    await page.evaluate(() => { delete window.__uiSmokeLastColour; });
  };
  await setTheme("ink");
  const ink = await worstReadableLink();
  const inkIcon = await worstIconControl();
  const inkRings = await sweepFocusRings();
  await setTheme("paper");
  const paper = await worstReadableLink();
  const paperIcon = await worstIconControl();
  const paperRings = await sweepFocusRings();
  await setTheme("ink"); // restore for the claim flow
  const both = [ink, paper].filter(Boolean);
  const worst = both.sort((a, b) => a.ratio - b.ratio)[0];
  ok(
    "worst readable link meets WCAG AA in both themes",
    ink != null && paper != null && worst != null && worst.ratio >= 4.5,
    worst ? (worst.unparseable ? `could not parse a colour on "${worst.unparseable}"` : `${worst.ratio.toFixed(2)}:1 "${worst.link}"`) : "no readable link found in a theme",
  );

  // Absence fails, and so does SUBSTITUTION, which is App's catch and the sharper of
  // the two. Firing only on zero matches left the check green when both controls this
  // exists for were given visible text: the selector stopped matching them, quietly
  // re-targeted onto the masthead logo, and reported 14.86:1 on a link that will
  // always pass. Green, while covering neither control it was written for. That is
  // #300's own shape, one level up. So the two are named, and every control measured
  // goes in the output rather than only the worst, so a reader can see the coverage
  // instead of inferring it from a single number.
  const icons = [inkIcon, paperIcon];
  const foundIcons = icons.every((i) => i && !i.unparseable);
  const worstIcon = foundIcons ? icons.slice().sort((a, b) => a.ratio - b.ratio)[0] : null;
  const unparseableIcon = icons.find((i) => i && i.unparseable);
  // The named set is the THEME TOGGLE only, since the contribute link grew a visible
  // label at desktop widths and is therefore covered by the text-contrast check above,
  // not this one. This guard fired BY NAME when the label landed, which is exactly the
  // substitution case it was built for, and moving the requirement rather than deleting
  // it keeps the contract honest: the link is icon-only below 560px, so its icon-contrast
  // assertion lives in the MOBILE pass, where that state actually exists.
  const missing = !foundIcons ? [] : ["theme toggle"].filter(() => !icons.every((c) => c.sawToggle));
  ok(
    "icon-only controls meet WCAG 1.4.11 in both themes",
    foundIcons && missing.length === 0 && worstIcon.ratio >= 3,
    unparseableIcon
      ? `could not parse a colour on "${unparseableIcon.unparseable}"`
      : !worstIcon
        ? "no icon-only control found in a theme, so nothing was checked"
        : missing.length
          ? `never measured the ${missing.join(" or the ")}; saw ${JSON.stringify(worstIcon.measured)}`
          : `worst glyph ${worstIcon.ratio.toFixed(2)}:1 on "${worstIcon.control}", its border ${worstIcon.border == null ? "unmeasurable" : `${worstIcon.border.toFixed(2)}:1`}; measured ${JSON.stringify(worstIcon.measured)}`,
  );

  // Same failure mode as #306, so the same guard. A sweep that reports the worst ring it
  // happened to reach says nothing about whether the controls worth reaching are still in
  // the tab order: lose the claim button and the address input and the worst of what
  // remains is a footer link that will always pass. So the two that matter are named, and
  // everything reached goes in the output rather than only the worst.
  const rings = [inkRings, paperRings];
  const reached = (r, re) => r.seen.some((n) => re.test(n));
  const ringsMissing = ["claim button", "address input"].filter((_, i) =>
    !rings.every((r) => reached(r, i === 0 ? /Request|Queue it|Checking status|Topping up|Waiting for/i : /testnet address/i)));
  const ringless = rings.map((r) => r.ringless).find(Boolean);
  const worstRing = rings.map((r) => r.worst).filter(Boolean).sort((a, b) => a.ratio - b.ratio)[0];
  ok(
    "the focus ring meets WCAG 1.4.11 in both themes",
    ringsMissing.length === 0 && !ringless && worstRing != null && worstRing.ratio >= 3,
    ringless
      ? `"${ringless}" takes focus with no visible ring at all`
      : ringsMissing.length
        ? `never reached the ${ringsMissing.join(" or the ")} by tabbing; reached ${JSON.stringify(rings[0].seen)}`
        : worstRing
          ? `worst ring ${worstRing.ratio.toFixed(2)}:1 on "${worstRing.name}" at ${worstRing.width}px; reached ${rings[0].seen.length} controls`
          : "tabbing reached no focusable control, so nothing was checked",
  );
}

// What the page says and does BEFORE the first /api/status answers.
//
// This window is real but short, roughly half a second on localhost, so driving it
// by racing the page is flaky by construction. Holding the response open makes it
// as long as we like, which turns a race into an assertion.
//
// Two separate properties, and the second is the one that bites. The page must not
// state a balance, a node state or a miner state it has not been told, AND a claim
// typed in that window must still be HELD. Adding the "checking" phase took the hold
// away by accident: the queue guard tested for "syncing" by name, so the claim fell
// through to a live POST with no proof of work attached and came back an error.
// `address` must be checksum-valid, or submit() bails at validation and never reaches
// the queue guard, which would make the hold assertion pass without testing anything.
async function checkFirstPaint(page, base, address) {
  let release;
  const held = new Promise((r) => { release = r; });
  // Once we stop intercepting, Playwright resolves whatever route is still suspended
  // here, and our continue() then throws "already handled". Which side finishes it does
  // not matter, but an unhandled rejection out of this callback kills the whole run.
  await page.route("**/api/status*", async (route) => {
    await held;
    try { await route.continue(); } catch { /* unrouted from under us */ }
  });

  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Checking status/ }).waitFor({ timeout: 15_000 });
    const body = await page.textContent("body");
    // Two different questions: the BADGE says CHECKING (read off the badge, not found
    // somewhere in the page), and the word LIVE appears nowhere at all on first paint.
    // Bounded and caught: a missing badge must fail THIS check with a reason, not throw
    // out of the run and take every later check's diagnosis with it.
    const badgeWord = (await page.getByTestId("status-word").textContent({ timeout: 5_000 }).catch(() => "no badge on the page"))?.trim();
    ok("first paint says CHECKING, not LIVE", badgeWord === "CHECKING" && !/\bLIVE\b/.test(body), badgeWord);

    // Read the status strip cell by cell rather than grepping the body. A body-wide
    // regex cannot do this job: the drip amount "0.1 TAZ" is legitimately on the page,
    // so "does a number followed by TAZ appear" is not a question with a useful answer.
    // The first version of this check tested /\b0 TAZ\b/ and passed with the bug still
    // in, because `?? 0` renders through toFixed(1) as "0.0 TAZ" and never matched.
    const cells = await page.evaluate(() => {
      const out = {};
      const strip = document.querySelector("[data-testid=status-strip]");
      for (const cell of strip?.querySelectorAll("[data-strip-key]") ?? []) {
        const key = cell.getAttribute("data-strip-key");
        const value = cell.querySelector("[data-testid=strip-value]")?.textContent?.trim();
        if (key) out[key] = value ?? "";
      }
      return out;
    });
    const DASH = "–";
    ok("the strip was found at all", Object.keys(cells).length > 0, JSON.stringify(cells));
    for (const k of ["node", "balance", "miner"]) {
      ok(`first paint states no ${k} it was not told`, cells[k] === DASH, `${k}=${cells[k] ?? "missing"}`);
    }

    // The regression. Type and submit while status is still held.
    await page.getByTestId("address-input").fill(address);
    await page.getByTestId("claim-button").click();
    await page.waitForTimeout(400);
    const after = await page.textContent("body");
    const queued = /Queued/.test(after);
    ok("a claim typed before the first status is HELD, not sent",
      queued, queued ? "" : after.match(/Couldn.t[^.]*\./)?.[0] ?? "no Queued panel");
  } finally {
    release();
    await page.unroute("**/api/status*");
    // The held claim has to be cleared from a page the app is NOT mounted on. Clearing
    // it while the home page is live does nothing: the claim is still in React state,
    // the persist effect writes it straight back, and the next load restores a queued
    // claim into a suite that assumes a clean faucet. That leak failed the LIVE-dot
    // check and hung the claim flow, both of which looked like unrelated regressions.
    await page.goto(`${base}/terms`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.removeItem("zfaucet_queued"));
  }
}

// EACH REFUSAL GETS THE CARD THAT IS TRUE OF IT (risk register II, R-34). The page
// branches on the reply's status and fields; the wallet double cannot produce most of
// these replies (a full cap, a 75 s freshness hold, a 504) so they are injected at the
// network layer with the bodies the route really sends, and the page's own switch is
// what is under test. Its own context: routes must not leak into the claim flow.
async function checkRefusalCards(browser, base, address) {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  const norm = (t) => t.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const card = async () => {
    const alerts = page.locator("[role=alert]").filter({ hasText: /\S/ });
    return {
      text: norm((await alerts.first().innerText().catch(() => "")) ?? ""),
      buttons: (await alerts.locator("button").allInnerTexts().catch(() => [])).map(norm),
    };
  };
  const shapes = [
    { name: "a freshness hold", status: 503, body: { error: "Our chain view is not fresh enough to send safely. Nothing was claimed, your cooldown is untouched. Try again shortly.", retryAfterSeconds: 3 },
      expect: async (c) => {
        ok("a 503 with a retryAfter is 'our side, not yours'", /our side, not yours/.test(c.text), c.text.split("\n")[0]);
        ok("and its button counts down, disabled", c.buttons.some((b) => /try again in \d+s/.test(b)) && await page.getByTestId("error-retry").isDisabled(), c.buttons.join("|"));
        await page.waitForFunction(() => { const b = document.querySelector("[data-testid=error-retry]"); return b && !b.disabled; }, null, { timeout: 8000 }).catch(() => {});
        ok("and enables when the wait is over", (await card()).buttons.includes("try again"));
      } },
    { name: "a full queue", status: 503, body: { error: "Faucet is busy: too many sends queued. Try again in a moment.", kind: "busy" },
      expect: async (c) => ok("kind busy is busy, with Try again", /busy, nothing left the wallet/.test(c.text) && c.buttons.includes("try again"), c.text.split("\n")[0]) },
    { name: "the daily cap", status: 503, body: { error: "Faucet daily cap reached. Please come back tomorrow.", kind: "cap", retryAfterSeconds: 5400, nextAt: new Date(Date.now() + 5_400_000).toISOString() },
      expect: async (c) => {
        ok("kind cap says the budget is spent, with the time it resets", /today's taz budget is spent/.test(c.text) && /room again around .*\d{1,2}:\d{2}/.test(c.text), c.text.split("\n")[0]);
        ok("and offers no Try again", !c.buttons.some((b) => /try again/.test(b)), c.buttons.join("|"));
      } },
    { name: "an unknown outcome", status: 504, body: { error: "Your drip was submitted but we lost track of it before it confirmed. Do not retry yet: if it went through, the coins are on their way. Check the address in a few minutes." },
      expect: async (c) => {
        ok("a 504 is 'submitted, outcome unknown' with the address and no Try again", /submitted, outcome unknown/.test(c.text) && c.text.includes(address.toLowerCase()) && !c.buttons.some((b) => /try again/.test(b)), c.buttons.join("|"));
      } },
    { name: "a bad request", status: 400, body: { error: "Invalid address." },
      expect: async (c) => {
        ok("a 400 offers Edit the address and no Try again", c.buttons.includes("edit the address") && !c.buttons.includes("try again"), c.buttons.join("|"));
        await page.getByTestId("error-edit").click();
        await page.waitForTimeout(300);
        ok("and Edit the address returns to the form with the address kept", (await page.getByTestId("address-input").inputValue()) === address && !(await page.locator("[role=alert]").filter({ hasText: /\S/ }).count()));
      } },
    { name: "a failed send", status: 502, body: { error: "The send failed on our side. Nothing left the wallet. Try again in a moment." },
      expect: async (c) => {
        ok("a 502 keeps the red card: send failed, nothing left the wallet, Try again", /send failed, nothing left the wallet/.test(c.text) && c.buttons.includes("try again"), c.text.split("\n")[0]);
        // The request id every API error carries, on the card, so a person writing in
        // has something to quote (R-39). "ui-smoke" is the id the route stub sends.
        ok("and the card shows the request id with a way to write in", /ref ui-smoke/.test(c.text) && (await page.locator("[data-testid=request-id] a[href='/terms']").count()) === 1);
      } },
  ];
  try {
    for (const s of shapes) {
      await page.route("**/api/faucet", (route) => route.fulfill({ status: s.status, contentType: "application/json", body: JSON.stringify({ ...s.body, requestId: "ui-smoke" }) }));
      await page.goto(base, { waitUntil: "networkidle" });
      await page.waitForFunction(() => /\bLIVE\b/.test(document.body.innerText), null, { timeout: 30_000 });
      await page.getByTestId("address-input").fill(address);
      await page.getByTestId("claim-button").click();
      // An EMPTY [role=alert] is always in the DOM; wait for one with text.
      await page.waitForFunction(() => [...document.querySelectorAll("[role=alert]")].some((e) => (e.textContent || "").trim()), null, { timeout: 60_000 }).catch(() => {});
      const c = await card();
      if (!c.text) ok(`${s.name}: a card rendered`, false, (await page.innerText("body")).slice(0, 160));
      else await s.expect(c);
      await page.unroute("**/api/faucet");
    }
  } catch (err) {
    ok("refusal cards ran to completion", false, err instanceof Error ? err.message : String(err));
  } finally {
    await ctx.close();
  }
}

// The miner readout, in the state CI actually runs in: no heartbeat path configured.
//
// That is the important case rather than a limitation. The old field was an env flag,
// so an unconfigured or broken miner still rendered "on", and a run with no heartbeat
// at all is exactly the shape that used to lie. What it must say now is that it cannot
// tell, which is neither healthy nor "off".
/**
 * Opens one of the four views the redesign's segmented nav switches between.
 *
 * The content did not go away, it went behind a nav, and a hidden section is not
 * clickable. Driving the nav is also what a visitor does, so this asserts the nav works on
 * the way to asserting what is inside: a broken nav fails here, by name, rather than fifty
 * lines later as a mystery timeout on something unrelated.
 */
async function showView(page, v) {
  await page.getByTestId(`nav-${v}`).click();
  await page.locator(`[data-testid="view-${v}"]`).waitFor({ state: "visible", timeout: 5000 });
}

async function checkMinerPanel(page) {
  // The panel and its disclosure live in the status view now.
  await showView(page, "status");
  // The control was reached by its label until this change, so the label needs its own
  // assertion. DRIVEN BY TESTID, ASSERTED BY ROLE AND NAME - SDE-Infra's finding, and it is
  // the right one: getByRole(name:) asserts the COMPUTED ACCESSIBLE NAME, which is what a
  // screen reader announces, while textContent is merely what the element happens to
  // contain. They agree today because the button has no aria-label; add one later and only
  // the role+name form notices.
  const toggle = page.getByTestId("panel-toggle");
  const namedButton = async (re) => (await page.getByRole("button", { name: re }).count()) === 1;
  ok("the disclosure is announced as More details when the panel is shut",
    await namedButton(/More details/), (await toggle.textContent())?.trim());
  await toggle.click();
  ok("and as Hide details when it is open",
    await namedButton(/Hide details/), (await toggle.textContent())?.trim());

  // Read the one cell, not the panel's textContent. There are no newlines in that
  // string, so a /miner\s*([^\n]*)/ match runs to the end and drags in reserve, queue
  // and backend. Every assertion below would then be answered by some other row.
  const row = await page.evaluate(() => {
    const hit = document.querySelector("[data-panel-key='miner']");
    return hit?.querySelector("[data-testid=panel-value]")?.textContent?.trim() ?? "";
  });

  ok("the panel reports the miner at all", row.length > 0, row);
  // CI sets no FAUCET_MINER_HEARTBEAT_PATH, so the honest answer here is that nobody
  // wired the reader up, NOT that a heartbeat is missing. Those are different facts
  // and this asserts the one that actually applies to this run.
  ok("an unconfigured heartbeat says so, and does not blame a missing file",
    /not watched, no heartbeat path/.test(row), row);
  ok("no heartbeat is NOT reported as running", !/\bmining\b/.test(row), row);
  // "off" is the specific wrong answer. We have not established the miner is off, only
  // that we cannot see it, and those call for different responses from an operator.
  ok("no heartbeat is NOT reported as off", !/\boff\b/.test(row), row);
  await page.getByTestId("panel-toggle").click();
}

/**
 * The TAZ/cTAZ toggle and a real cTAZ claim (#326).
 *
 * Everything below is asserted from the RENDERED PAGE rather than from the API, because
 * the whole risk in this change is a page that says the wrong thing about a correct
 * response: a manufactured txid, a copy button for an id that does not exist, an
 * explorer link to a chain we cannot look anything up on.
 *
 * SKIPS LOUDLY when cTAZ is off. Returning early with no output would leave a run that
 * covered none of this looking identical to one that covered all of it.
 */
async function checkCtazToggle(page, base) {
  const status = await (await fetch(`${base}/api/status`)).json();
  if (!status?.ctaz?.enabled) {
    console.log("SKIP: cTAZ is off on this run, so the toggle, the cTAZ claim and the no-txid receipt were NOT covered");
    console.log("      (start scripts/fake-crosslink.mjs and set FAUCET_CTAZ_ENABLED=true to exercise them)");
    return;
  }

  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  const tabs = page.getByRole("tab");
  ok("the network toggle offers both networks", (await tabs.count()) === 2, `${await tabs.count()} tabs`);

  // The beta marking has to be part of the tab's ACCESSIBLE NAME, not only its pixels.
  // Two spans in a flex row compute as "cTAZfeature net, beta" with no separator, which
  // is why the button carries an explicit label. Caught in a browser, not in a unit test.
  const ctazTab = page.getByRole("tab", { name: /cTAZ/ });
  const label = await ctazTab.getAttribute("aria-label");
  ok("cTAZ is marked as a feature net in its accessible name", /feature net/i.test(label ?? ""), label ?? "(none)");
  ok("TAZ is selected first, so nobody lands on the feature net by default",
    (await page.getByRole("tab", { name: /^TAZ/ }).getAttribute("aria-selected")) === "true");

  // Arrow keys must move within the tablist, which is the half of the pattern that is
  // easy to leave out and impossible to notice with a mouse.
  await ctazTab.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  ok("arrow keys move between the tabs",
    (await page.getByRole("tab", { name: /^TAZ/ }).getAttribute("aria-selected")) === "true");

  await ctazTab.click();
  await page.waitForTimeout(300);
  ok("the claim button quotes the cTAZ amount, not the TAZ one",
    /0\.5 cTAZ/.test((await page.getByTestId("claim-button").textContent()) ?? ""),
    (await page.getByTestId("claim-button").textContent())?.trim());

  // The panel's cTAZ rows. `reserve` is the one that matters: their surface has no
  // balance method, so anything numeric here would be invented.
  //
  // NO "ctaz" PREFIX ON THE KEYS ANY MORE, and no filtering by one either. The panel now
  // shows only the selected asset, so the prefix that used to disambiguate against a TAZ
  // row on the same screen is gone. Reading every row is also what lets the next two
  // assertions exist: they check what is ABSENT, which a prefix filter could never see.
  const panelRows = async () =>
    Object.fromEntries(
      await page.evaluate(() =>
        [...document.querySelectorAll("[data-panel-key]")].map((c) => [
          c.getAttribute("data-panel-key"),
          c.querySelector("[data-testid=panel-value]")?.textContent?.trim(),
        ])),
    );

  await showView(page, "status");
  await page.getByTestId("panel-toggle").click();
  const rows = await panelRows();
  ok("the panel gains a cTAZ readiness row", /ready|behind|stale|not-activated|cannot-verify/.test(rows["node"] ?? ""), rows["node"]);
  ok("the cTAZ reserve reads unknown, never a number", rows["reserve"] === "unknown", rows["reserve"]);
  ok("the cTAZ drip counter is its own", rows["drips ever/7d/30d"] !== undefined, rows["drips ever/7d/30d"]);

  // THE SEPARATION ITSELF, which is the point of the change and the thing a reader is
  // hurt by if it regresses. A TAZ wallet balance under a cTAZ tab is how someone
  // concludes the cTAZ wallet holds 1000 TAZ.
  ok("no TAZ-only row leaks onto the cTAZ tab",
    rows["wallet balance"] === undefined && rows["miner"] === undefined && rows["refill"] === undefined,
    Object.keys(rows).join(", "));
  ok("box and backend stay on both tabs, being about the machine not the chain",
    rows["box"] !== undefined && rows["backend"] !== undefined);

  // And the mirror, so neither assertion can pass by the panel simply being empty.
  // The network tabs are the CLAIM view's, the panel is the STATUS view's, so the tab
  // click needs the claim view back. Reading the rows does not: panelRows() reads the DOM
  // rather than the screen, and the panel stays mounted once it is open.
  await showView(page, "claim");
  await page.getByRole("tab", { name: /^TAZ/ }).click();
  await page.waitForTimeout(300);
  const tazRows = await panelRows();
  ok("the TAZ tab carries its own rows back", tazRows["wallet balance"] !== undefined && tazRows["miner"] !== undefined);
  ok("and the cTAZ-only rows are gone from it", tazRows["reserve"] === undefined, Object.keys(tazRows).join(", "));
  await ctazTab.click();
  await page.waitForTimeout(300);
  await showView(page, "status");
  await page.getByTestId("panel-toggle").click();
  // The claim below is driven through the claim view's own controls.
  await showView(page, "claim");

  // A real claim on the feature net, through the button and the proof of work.
  const address = await freshAddress();
  await page.getByTestId("address-input").fill(address);
  await page.getByTestId("claim-button").click();
  await page.getByTestId("sent-badge").waitFor({ timeout: 120_000 });
  ok("a cTAZ claim driven through the UI succeeds", true);
  // The success card is reached by its testid now, so the WORDS need an assertion of
  // their own: "Sent ✓" is what a person reads to know the drip went, and until this
  // change the selector was the only thing holding it.
  ok("and the card says Sent ✓, not merely something with that testid",
    (await page.getByTestId("sent-badge").textContent())?.trim() === "Sent ✓",
    (await page.getByTestId("sent-badge").textContent())?.trim());

  const body = await page.textContent("body");
  ok("the receipt shows what the network PAID", /0\.5 cTAZ/.test(body));
  // The #323 ruling, three ways. Each is a separate assertion because each is a
  // separate way to imply an id exists.
  ok("the receipt SAYS there is no transaction id", /none, this network returns none/.test(body));
  ok("no copy-txid button is offered when there is no txid",
    (await page.getByRole("button", { name: /Copy txid/ }).count()) === 0);
  ok("no explorer link is offered when there is nothing to look up",
    (await page.getByRole("link", { name: /Open in explorer/ }).count()) === 0);
  // A manufactured id would most likely be an empty string or a run of zeros, and both
  // would render as a txid row rather than as the explanation.
  ok("no fabricated txid appears anywhere on the receipt", !/[0-9a-f]{32}/.test(body));

  // The pasteable receipt has to carry the absence too. A dropped line reads as a
  // truncated paste to whoever receives it.
  await page.getByRole("button", { name: /Copy receipt/ }).click();
  await page.waitForTimeout(300);
  const receipt = String(await page.evaluate(() => navigator.clipboard.readText().catch(() => "")));
  ok("the copied receipt states the absence rather than omitting the line",
    /txid:\s+none/.test(receipt), receipt.split("\n").find((l) => l.startsWith("txid")) ?? "(no txid line)");
  ok("the copied receipt names the chain it was paid on", /Crosslink/.test(receipt));

  await page.getByRole("button", { name: /Another address/ }).click();
}

/**
 * THE PHONE (#337). Everything above runs at the default desktop viewport, which is
 * how a footer ended up sitting on top of two working controls on the page most
 * visitors land on. The desktop pass was green throughout.
 *
 * Runs in its OWN context, because a viewport and a touch profile are context-level
 * and cannot be set on a page that already exists. `devices["iPhone 13"]` brings
 * `hasTouch` with it, which is what makes the `pointer: coarse` rules apply: without
 * it the 44px tap-target floor is never exercised and the check would pass by never
 * asking.
 *
 * Three properties, chosen because each one is a way the page stops WORKING rather
 * than a way it looks wrong:
 *
 *   NO HORIZONTAL OVERFLOW. Content off the right edge is content nobody reads.
 *   NOTHING PINNED SITS ON A CONTROL. This is the reported bug, generalised: any
 *     fixed or sticky element whose box intersects an interactive element's box.
 *     Stated as geometry rather than as "the footer", so the next pinned thing is
 *     covered by a test nobody has to remember to extend.
 *   TAP TARGETS REACH 44px. The floor, and the rule that enforces it keyed on a
 *     class the masthead's two icon controls do not have, so both were 30px.
 */
async function checkMobile(browser, base) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  // Its own error collector. The desktop run asserts a clean console over its own
  // flow, and folding these in would blame this pass for anything it inherited.
  const seen = [];
  page.on("pageerror", (e) => seen.push(`uncaught: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") seen.push(`console: ${m.text()}`); });

  const audit = async (label) => {
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const vw = window.innerWidth;
      const wide = [...document.querySelectorAll("body *")]
        .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > vw + 1; })
        .slice(0, 3)
        .map((e) => `${e.tagName}${e.className ? "." + String(e.className).split(" ")[0] : ""}`);
      const pinned = [...document.querySelectorAll("body *")]
        .filter((e) => ["fixed", "sticky"].includes(getComputedStyle(e).position) && e.getBoundingClientRect().height > 0);
      const covered = new Set();
      for (const p of pinned) {
        const pr = p.getBoundingClientRect();
        for (const e of document.querySelectorAll("a,button,input,summary")) {
          if (p.contains(e)) continue;                 // its own children are not covered
          const er = e.getBoundingClientRect();
          if (er.height === 0) continue;
          if (er.top < pr.bottom && er.bottom > pr.top && er.left < pr.right && er.right > pr.left) {
            covered.add((e.textContent || e.getAttribute("aria-label") || e.tagName).trim().slice(0, 30));
          }
        }
      }
      const small = [...document.querySelectorAll("a.btn,a.theme-toggle,button,input")]
        .filter((e) => { const b = e.getBoundingClientRect(); return b.height > 0 && b.height < 44; })
        .slice(0, 3)
        .map((e) => `${(e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 22)} h=${Math.round(e.getBoundingClientRect().height)}`);
      return { docW: document.documentElement.scrollWidth, vw, wide, covered: [...covered].slice(0, 3), small };
    });
    ok(`mobile ${label}: no horizontal overflow`, r.docW <= r.vw, `${r.docW} vs ${r.vw}${r.wide.length ? " :: " + r.wide.join(", ") : ""}`);
    ok(`mobile ${label}: nothing pinned covers a control`, r.covered.length === 0, r.covered.join(", "));
    ok(`mobile ${label}: tap targets reach 44px`, r.small.length === 0, r.small.join(", "));
    // THE ICON-ONLY CONTROL'S 1.4.11 GUARD, AND ITS SUBJECT MOVED (the redesign's shell).
    // This measured `a.contribute`, which was icon-only at this width and labelled above
    // 560px. The approved design has no contribute link in the header at all: the source
    // is a text link in the footer now, where the text-contrast check owns it. That leaves
    // the THEME TOGGLE as the only icon-only control on the page, which is precisely what
    // this guard is for, so it follows the state rather than being deleted with the old
    // markup. Note what is NOT carried over: there is no `labelled` case any more, because
    // this control is icon-only at every width by design.
    if (label.startsWith("/ ") || label === "/ ink" || label === "/ paper") {
      const icon = await page.evaluate(`(() => {
        ${COLOUR_LIB}
        const el = [...document.querySelectorAll("[data-testid=theme-toggle]")].find((e) => e.getBoundingClientRect().width > 0);
        if (!el) return { missing: true };
        const ratio = ratioOf(getComputedStyle(el).color, el);
        return { ratio };
      })()`);
      ok(
        `mobile ${label}: the icon-only control keeps 1.4.11 contrast`,
        !icon.missing && icon.ratio != null && icon.ratio >= 3,
        icon.missing ? "theme toggle not found, so nothing was measured" : `glyph ${icon.ratio?.toFixed(2)}:1`,
      );
    }
  };

  try {
    // Every page a visitor can reach, both themes. /fund is in here deliberately:
    // that is where the sticky bar was covering "Copy address", and it is the page
    // whose address is real money.
    for (const theme of ["ink", "paper"]) {
      await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
      await page.evaluate((t) => localStorage.setItem("zfaucet_theme", t), theme);
      for (const path of ["/", "/donate", "/fund", "/terms"]) {
        await page.goto(base + path, { waitUntil: "networkidle", timeout: 60_000 });
        await audit(`${path} ${theme}`);
      }
    }

    // The panel open, which is the tallest the home page gets before a claim.
    await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
    await showView(page, "status");
    await page.getByTestId("panel-toggle").click();
    await audit("/ panel open");

    // And the receipt, the one state that only exists after a real claim. Checked on
    // a phone because it is the state a claimant is actually looking at, and it is
    // the longest card on the page.
    await page.getByTestId("panel-toggle").click();
    await showView(page, "claim");
    await page.getByRole("button", { name: "Make a throwaway address and key" }).first().click();
    await page
      .waitForFunction(() => (document.querySelector("[data-testid=address-input]")?.value ?? "").length > 100, null, { timeout: 20_000 })
      .catch(() => {});
    await page.getByRole("button", { name: "Copy key" }).first().click();
    await page.getByTestId("claim-button").click();
    await page.getByTestId("sent-badge").waitFor({ timeout: 120_000 });
    await audit("/ receipt");

    ok("mobile: no page or console errors at 375x812", seen.length === 0, seen.slice(0, 2).join(" | "));
  } catch (err) {
    ok("mobile pass ran to completion", false, err instanceof Error ? err.message : String(err));
  } finally {
    await ctx.close();
  }
}

// The 404 must wear the site chrome, not Next's bare default. A broken not-found
// route renders as the framework default, which has no mark, so this fails on it.
async function check404(page, base) {
  const res = await page.goto(`${base}/this-route-does-not-exist`, { waitUntil: "networkidle" });
  ok("an unknown path returns a real 404", res?.status() === 404, String(res?.status()));
  ok("the 404 wears the site chrome", await page.getByTestId("brand-mark").isVisible());
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: DESKTOP, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();

// Anything the page logs as an error, or any uncaught exception, fails the run.
// A React hydration mismatch or a bad import surfaces here and nowhere else.
const problems = [];
page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ""}`));

try {
  // First, because it is the only check that needs the page to have asked nothing yet.
  await checkFirstPaint(page, BASE, await freshAddress());

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
  ok("page renders its heading", (await page.textContent("body")).includes("Get free testnet ZEC"));
  ok("status bar reached the API", /balance\s/.test(await page.textContent("body")));

  // Visual + a11y checks before the claim flow, while the home page is loaded.
  await checkAppearance(page);
  await checkFooterReachable(browser);
  await checkCardInnerPadding(browser);
  await checkLegacyPalette(browser);
  await checkChunkOrderIdentity(browser);
  // WHERE THE TAZ COMES FROM follows the status (R-39). Under this stack there is no
  // miner heartbeat, so the sentence has to be the not-mining one; the three
  // contradictory fixed sentences must be gone from the rendered page.
  {
    // Both tools sit behind the Tools view now, so open that before driving them.
    await showView(page, "tools");
    // The sentence lives in the "How it works" view; open it the way a visitor does.
    await page.getByRole("button", { name: "How it works" }).click();
    await page.locator("#tool-about").waitFor({ timeout: 5000 });
    const text = await page.locator("#tool-about").innerText();
    await page.getByRole("button", { name: "How it works" }).click();
    ok("the income sentence follows the miner state (no heartbeat here: not mining, topped up by hand)", /The faucet is not mining right now, so what it hands out is donated or topped up by hand\./.test(text), text.match(/The faucet (mines|is not mining|has had)[^.]*\./)?.[0] ?? "no income sentence found");
    ok("and none of the old fixed sentences remain", !/does not currently earn from mining|income rounds to zero|refilled by hand at the moment|mining and shielding its own coins/.test(text));
  }
  {
    // THE BALANCE LOOKUP LEAVES THE BROWSER AS A POST WITH NOTHING IN THE URL (risk
    // register II, R-36). The address used to travel as ?address=, which is the one
    // part of a request every hop keeps: the proxy's access line, a browser history.
    // Driving the button and reading the request the page makes, not the API.
    const seen = [];
    const onReq = (r) => { if (r.url().includes("/api/balance")) seen.push({ method: r.method(), url: r.url(), body: r.postData() ?? "" }); };
    page.on("request", onReq);
    await page.getByRole("button", { name: "Balance lookup" }).click();
    // A real shielded address from the app's own account API: the answer is
    // "private, not queryable", made with no external call and no 400 in the console.
    const lookupAddr = await freshAddress();
    await page.locator("#lk").fill(lookupAddr);
    await page.getByRole("button", { name: "Look up" }).click();
    // Settle on the answer, not on "Looking up…": that interim text is set before
    // the request is even sent.
    await page.waitForFunction(() => /Shielded balances are private|TAZ ·|Couldn't|No balance|nothing to look up/.test(document.querySelector("#tool-lookup")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
    page.off("request", onReq);
    ok("the lookup button makes exactly one /api/balance request", seen.length === 1, JSON.stringify(seen));
    const req = seen[0] ?? { method: "", url: "", body: "" };
    ok("and it is a POST whose URL carries no address", req.method === "POST" && !/[?&]address=/.test(req.url) && !req.url.includes(lookupAddr.slice(0, 24)), `${req.method} ${req.url}`);
    ok("and the address is in the body", req.body.includes(`"address":"${lookupAddr}"`), req.body.slice(0, 60));
    ok("and the page answers that a shielded balance is private", /Shielded balances are private/.test(await page.locator("#tool-lookup").innerText()));
    await page.getByRole("button", { name: "Balance lookup" }).click();
  }
  await checkMinerPanel(page);
  // The claim flow below drives input.input and button.btn-primary, which belong to the
  // claim view. Leave the nav where the rest of this file expects to find things.
  await showView(page, "claim");

  // THE PROOF OF WORK IS EXPLAINED BEFORE IT RUNS, ESTIMATED WHILE IT RUNS, AND CAN BE
  // ABANDONED; A BAD CHECKSUM COSTS NO SOLVE (risk register II, R-38).
  {
    ok("the puzzle is explained under the button before anyone presses it", /solves a short puzzle instead of a CAPTCHA/.test(await page.textContent("body")));
    // An address one character off. The server would say the same at 400, but only after
    // the browser had solved a proof of work for nothing; now it never asks for one.
    const good = await freshAddress();
    const last = good.at(-1);
    const bad = good.slice(0, -1) + (last === "q" ? "p" : "q");
    const asked = [];
    const onReq = (r) => { if (/\/api\/(pow\/challenge|faucet)$/.test(r.url())) asked.push(`${r.method()} ${new URL(r.url()).pathname}`); };
    page.on("request", onReq);
    await page.getByTestId("address-input").fill(bad);
    await page.getByTestId("claim-button").click();
    await page.waitForFunction(() => /bad bech32m checksum/.test(document.querySelector("#addrmsg")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
    // Short timeouts with a fallback: with the check missing the page is on the error
    // card by now and #addrmsg is gone, and that must read as THIS failing, not a hang.
    const addrmsg = (await page.locator("#addrmsg").textContent({ timeout: 3000 }).catch(() => "")) ?? "";
    ok("a bad checksum is refused on the page, in the route's own words", /Malformed unified address \(bad bech32m checksum\)/.test(addrmsg), addrmsg.slice(0, 120) || "no #addrmsg on the page");
    if (!/bad bech32m checksum/.test(addrmsg)) { await page.getByRole("button", { name: "Edit the address" }).click({ timeout: 3000 }).catch(() => {}); }
    ok("and no challenge was fetched and no claim was posted for it", asked.length === 0, asked.join("|"));
    // Cancel, mid-solve: the worker is replaced by one that reports progress and never
    // finds, so the card is on screen long enough to read and to leave. Two rates in
    // turn, 8192 hashes in 8000 ms and then in 2000 ms: at the stack's 12 bits those are
    // 4 s and 1 s, and the card must say each in its turn. One rate landed in the same
    // bucket as a hard-coded sentence and a constant passed the check (review of #541);
    // two different figures from two different rates is arithmetic or nothing.
    for (const [ms, expect] of [[8000, "about 4 s"], [2000, "about 1 s"]]) {
      await page.route("**/pow-worker.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: `self.onmessage=function(){setInterval(function(){self.postMessage({type:"progress",hashes:8192,ms:${ms}})},40)};` }));
      await page.getByTestId("address-input").fill(good);
      await page.getByTestId("claim-button").click();
      const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true });
      await cancelBtn.waitFor({ timeout: 5000 }).catch(() => {});
      // The worker first, so the sentence read below is one the worker's report produced.
      // It starts once the challenge fetch lands, so poll for it rather than assume.
      for (let i = 0; i < 50 && page.workers().length === 0; i++) await page.waitForTimeout(100);
      ok(`a worker is running while the card is up (rate ${8192 / ms} hashes/ms)`, page.workers().length === 1, `${page.workers().length} workers`);
      await page.waitForFunction((e) => document.body.innerText.includes(`Usually ${e} on this device`), expect, { timeout: 5000 }).catch(() => {});
      const sentence = ((await page.textContent("body")) ?? "").match(/(Usually|Measuring)[^.]*\./)?.[0] ?? "no estimate sentence";
      ok(`and the card says "Usually ${expect}": 2^12 at the reported rate, as a lottery's expected duration`, sentence.includes(`Usually ${expect} on this device`), sentence);
      await cancelBtn.click({ timeout: 3000 }).catch(() => {});
      await page.getByTestId("claim-button").waitFor({ timeout: 5000 }).catch(() => {});
      ok("Cancel returns to the form with the address still in it", (await page.getByTestId("address-input").inputValue({ timeout: 3000 }).catch(() => "")) === good);
      // The worker must be gone, not just the card: a Cancel that only hid the card left
      // a phone's CPU pinned, and an orphan that later found would null the refs of the
      // next solve. A never-finding worker cannot exit on its own, so 0 means terminated.
      await page.waitForTimeout(100);
      ok("and Cancel terminated the worker", page.workers().length === 0, `${page.workers().length} workers still running`);
      await page.unroute("**/pow-worker.js");
    }
    ok("and the abandoned solve posted nothing", !asked.some((a) => a.startsWith("POST /api/faucet")), asked.join("|"));
    page.off("request", onReq);
    // If a check above left the page off the form, put it back so the rest of the run
    // is not lost to a 30 s locator timeout with the diagnosis already printed.
    if (!(await page.getByTestId("claim-button").isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.getByRole("button", { name: "Cancel", exact: true }).click({ timeout: 1000 }).catch(() => {});
      await page.getByRole("button", { name: /Edit the address|Try again|Another address/ }).first().click({ timeout: 2000 }).catch(() => {});
    }
    await page.getByTestId("address-input").fill("", { timeout: 3000 }).catch(() => {});
  }

  // Generate-then-claim, the flow #31 broke for every visitor: the button read
  // the address from the wrong field and substituted a synthesized one that
  // checksum validation refuses. Driving the button, not the API, is what
  // catches it.
  await page.getByRole("button", { name: "Make a throwaway address and key" }).first().click();
  // Settle on a filled field OR a visible error, then assert. Both #31 shapes
  // then fail by name rather than timing out: reading the wrong response field
  // leaves the box empty today, and the older synthesized fallback filled it
  // with a too-short address.
  await page
    .waitForFunction(
      () => (document.querySelector("[data-testid=address-input]")?.value ?? "").length > 0 || /Couldn.t (generate|reach)/.test(document.body.innerText),
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  const generated = await page.getByTestId("address-input").inputValue();
  ok("the generate button yields a full unified address", generated.length > 100, `${generated.length} chars`);
  if (generated.length <= 100) throw new Error("generate did not produce a usable address, skipping the claim it feeds");
  // THE KEY COMES WITH IT, AND THE REQUEST WAITS FOR IT (risk register II, R-31). For
  // seven weeks this exact flow paid an address whose key the page had thrown away, and
  // this script clicked straight through it green. The key is shown masked, the request
  // button is held until it has been copied, and the receipt offers it again.
  const keyPanel = page.getByTestId("generated-key");
  ok("the generated address comes with its spending key on screen", await keyPanel.isVisible());
  const primary = page.getByTestId("claim-button");
  ok("and the request button waits until the key has been copied", (await primary.isDisabled()) && /Copy the key first/.test((await primary.textContent()) ?? ""), (await primary.textContent())?.trim());
  // A disabled button is no gate against a keyboard: Enter in the address field calls
  // submit() directly. The gate lives in submit() too, so Enter must change nothing.
  await page.getByTestId("address-input").press("Enter");
  await page.waitForTimeout(400);
  // If the gate let Enter through, the form is gone (the page is solving or sending)
  // and the button no longer exists: that is the failure, named, not a locator timeout.
  const stillHeld = await primary.isDisabled({ timeout: 2_000 }).catch(() => false);
  ok("Enter in the address field does not slip past the key gate", stillHeld, (await primary.textContent({ timeout: 1_000 }).catch(() => "form gone: the claim went ahead"))?.trim());
  // Review typed one character and deleted it: the first cut cleared the key on any
  // edit, so the exact generated address came back with no panel and a normal button.
  // The panel and the gate are keyed on the address; a round trip must change nothing.
  const field = page.getByTestId("address-input");
  await field.press("End");
  await field.type("x");
  ok("editing the address hides the key panel", !(await keyPanel.isVisible()), "panel visible with a different address");
  await field.press("Backspace");
  const backHeld = await primary.isDisabled({ timeout: 2_000 }).catch(() => false);
  ok("and typing it back re-shows the panel with the gate still closed", (await keyPanel.isVisible()) && backHeld, (await primary.textContent({ timeout: 1_000 }).catch(() => "form gone"))?.trim());
  // Masked BEFORE reveal: the secret must not be in the page until asked for.
  const masked = (await keyPanel.getByTestId("generated-key-secret").textContent()) ?? "";
  ok("the key is masked until revealed", /^•+$/.test(masked), `${masked.length} chars`);
  await keyPanel.getByRole("button", { name: "Copy key" }).click();
  // `!el?.disabled` is true when el is MISSING, so a renamed class would have made this
  // wait resolve at once and the next line read the button before React applied the
  // post-copy state: an intermittent false red in exactly the PR these hooks protect.
  // Requiring the element means a missing button times out and says so instead.
  await page.waitForFunction(() => {
    const b = document.querySelector("[data-testid=claim-button]");
    return !!b && !b.disabled;
  }, null, { timeout: 5_000 }).catch(() => {});
  ok("copying the key releases the request button", await primary.isEnabled(), (await primary.textContent())?.trim());
  await keyPanel.getByRole("button", { name: "Reveal" }).click();
  const shown = (await keyPanel.getByTestId("generated-key-secret").textContent()) ?? "";
  ok("revealed, the key is a real secret and not the mask", shown.length > 40 && !/^•+$/.test(shown), `${shown.length} chars`);
  // The clipboard holds the KEY, not the address: a copy button that copied the wrong
  // field would pass every visibility check above and leave the person with nothing.
  const clipKey = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  ok("what Copy key put on the clipboard is the revealed key", clipKey === shown, `${clipKey.length} chars, ${clipKey === generated ? "the ADDRESS" : "not the address"}`);
  await primary.click();
  await page.getByTestId("sent-badge").waitFor({ timeout: 120_000 });
  ok("a generated address is accepted by the faucet (#31)", true);
  ok("the receipt offers the spending key again", await page.getByRole("button", { name: "Copy spending key" }).isVisible());
  await page.getByRole("button", { name: "Copy spending key" }).click();
  const clipAgain = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  ok("and it copies the same key", clipAgain === shown, `${clipAgain.length} chars`);
  await page.getByRole("button", { name: /Another address/ }).click();

  const address = await freshAddress();
  await page.getByTestId("address-input").fill(address);
  const submit = page.getByTestId("claim-button");
  ok("the claim button is offered", await submit.isEnabled(), (await submit.textContent())?.trim());
  await submit.click();

  // Covers the in-page proof-of-work worker as well as the claim round trip.
  await page.getByTestId("sent-badge").waitFor({ timeout: 120_000 });
  ok("a claim driven through the UI succeeds", true);
  const success = await page.textContent("body");
  ok("success names the address it sent to", success.includes(address.slice(-6)));
  ok("success shows a txid", /[0-9a-f]{10}/.test(success));

  await page.getByRole("button", { name: /Copy txid/ }).click();
  await page.waitForTimeout(300);
  const copied = String(await page.evaluate(() => navigator.clipboard.readText().catch(() => "")));
  ok("copy txid puts a 64-hex txid on the clipboard", /^[0-9a-f]{64}$/.test(copied), copied.slice(0, 16));

  // After the TAZ claim, so the TAZ path is proven unregressed before the new one runs.
  await checkCtazToggle(page, BASE);

  // Assert the clean-console guarantee on the whole claim flow BEFORE the 404
  // check, which deliberately loads a 404 and would otherwise pollute this.
  ok("no page errors, console errors or failed requests", problems.length === 0, problems.slice(0, 3).join(" | "));

  // The refusal cards, in their own context with the claim route intercepted.
  await checkRefusalCards(browser, BASE, await freshAddress());

  // The phone. Its own browser context, so it cannot disturb the desktop page above
  // it, and after the desktop claim so a mobile failure is never the first thing to
  // go red when something more basic is broken.
  await checkMobile(browser, BASE);

  // Last, because it navigates away and intentionally hits a 404.
  await check404(page, BASE);
} catch (err) {
  ok("browser smoke ran to completion", false, err instanceof Error ? err.message : String(err));
  if (problems.length) console.log(`  page problems seen: ${problems.slice(0, 3).join(" | ")}`);
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nui-smoke: all green" : `\nui-smoke: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
