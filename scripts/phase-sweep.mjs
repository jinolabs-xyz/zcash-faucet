// S2 acceptance: the claim card animates its own height and NOTHING outside it moves.
// Owner ruling 2026-09-15T18:56Z. The preview's phase-test.mjs drives its phases through
// window.__faucetPreview.setPhase; this app has no such hook and should not grow one
// (CTO, 19:38Z: phases come from the doubles). So each phase here is reached by serving
// the page a MUTATED COPY OF A REAL /api/status BODY, captured from the running app at
// startup, with only the fields basePhase() actually branches on changed.
//
//   UI=http://localhost:3162 node phase-sweep.mjs
//
// Every phase is WITNESSED before it is measured: the page's own live region
// (p.sr-only[role=status], page.tsx:1200) holds one stable sentence per phase, so a
// mutation that failed to drive the phase is reported as unreached rather than measured
// as a pass. A phase that is skipped and prints "ok" is worse than no check.
import { chromium } from "playwright";

const BASE = process.env.UI ?? "http://localhost:3162";
const VIEWPORTS = [[1440, 900], [1280, 800]];

let ok = 0, fail = 0;
const t = (name, pass, detail = "") => { if (pass) { ok++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? "  <- " + detail : ""}`); } };

const real = await (await fetch(`${BASE}/api/status`)).json();
const clone = () => JSON.parse(JSON.stringify(real));

// basePhase(), page.tsx:442-486, in order:
//   !s -> checking | faultReason(s) -> fault | node.ready === false -> syncing
//   balanceTaz == null -> syncing | balanceTaz <= 0 || empty -> empty
//   sends.state === "degraded" -> degraded | else ready
const PHASES = [
  { name: "ready",      says: "Faucet ready.",            mutate: (s) => s },
  { name: "syncing",    says: "Node is syncing",          mutate: (s) => { s.node = { ...(s.node ?? {}), ready: false }; return s; } },
  { name: "fault",      says: "having a problem",         mutate: (s) => { s.backend = { ...(s.backend ?? {}), reachable: false }; return s; } },
  { name: "empty",      says: "out of TAZ right now",     mutate: (s) => { s.empty = true; s.balanceTaz = 0; if (s.reserve) s.reserve.refilling = false; return s; } },
  { name: "topping-up", says: "Topping up the reserve",   mutate: (s) => { s.empty = true; s.balanceTaz = 0;
      s.reserve = { ...(s.reserve ?? { targetTaz: 100, lowTaz: 5, spendableTaz: 0 }), refilling: true, shieldCoinbase: true };
      s.miner = { ...(s.miner ?? {}), active: true }; return s; } },
  { name: "degraded",   says: "Sends are failing",        mutate: (s) => { s.sends = { ...(s.sends ?? {}), state: "degraded" }; return s; } },
];

const geom = (p) => p.evaluate(() => {
  const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
  const card = r("#claim"), copy = r(".hero-copy"), fox = r(".hero-mascot"), h1 = r("h1");
  return {
    card: card ? card.height : null,
    copy: copy ? copy.top : null,
    fox: fox ? fox.top : null,
    h1: h1 ? h1.top : null,
    says: (document.querySelector("p.sr-only[role=status]")?.textContent ?? ""),
  };
});

const browser = await chromium.launch();
let deltas = 0, transitions = 0;          // anti-vacuity counters

let STATUS_DELAY_MS = 0;
for (const [speed, delay] of [["fast double", 0], ["slow, like production", 800]]) {
STATUS_DELAY_MS = delay;
for (const [W, H] of VIEWPORTS) {
  console.log(`\n${W}x${H}  (${speed})`);
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  let current = PHASES[0];
  await page.route("**/api/status", async (route) => {
    // THE DOUBLES ANSWER IN UNDER A MILLISECOND AND PRODUCTION DOES NOT. Measured TTFB on prod
    // is about 790ms, and a status phase change is TWO renders, so on the real site an effect
    // that ran per render cancelled the animation about 210ms in and the card snapped the rest.
    // The whole defect was invisible here until the slow pass existed.
    if (STATUS_DELAY_MS) await new Promise((r) => setTimeout(r, STATUS_DELAY_MS));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current.mutate(clone())) });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#claim", { timeout: 15000 });
  // RECORD THE ANIMATION rather than sampling geometry and hoping to catch it in flight. The
  // first version polled the card's height and called the transition a jump if the sample was
  // already most of the way to the new value - which is a statement about how fast the poll
  // came round, not about the card. Under load one row read 86% of the way through a 460ms
  // animation and failed on a tree where the animation was correct. A check whose verdict
  // depends on machine load is a flake aimed at whoever runs it next.
  //
  // The card calls el.animate(); this wraps it and keeps the keyframes. It asks whether ANY
  // animation since the phase changed starts at the height the card had BEFORE it - not the
  // first one - because the effect runs per render and a countdown tick can register its own.
  await page.evaluate(() => {
    const el = document.querySelector("#claim");
    window.__cardAnims = [];
    const original = el.animate.bind(el);
    el.animate = (frames, opts) => {
      // KEEP THE OPTIONS AND THE OUTCOME, not just the keyframes. The first version held only
      // the frames and asked whether some animation's `to` matched, which a 460ms animation and
      // a 1ms one satisfy identically - `duration: 1` survived the whole sweep at 29/0. And an
      // animation that is CANCELLED two frames in registered exactly like one that ran, which is
      // the defect this round is about: the card snapped and the sweep applauded.
      const rec = { frames: null, opts: null, state: "running", at: performance.now() };
      try { rec.frames = JSON.parse(JSON.stringify(frames)); } catch { /* ignore */ }
      try { rec.opts = JSON.parse(JSON.stringify(opts)); } catch { /* ignore */ }
      window.__cardAnims.push(rec);
      const a = original(frames, opts);
      // `finished` rejects when an animation is cancelled, which is exactly the distinction.
      a.finished.then(() => { rec.state = "finished"; }, () => { rec.state = "cancelled"; });
      return a;
    };
    // EVERY PAINTED FRAME, because the keyframes alone cannot say whether the card SNAPPED.
    // The wrapper above proves an animation ran from A to B; it says nothing about the card
    // moving un-animated between two animations, which is the 20px step out of `fault` the
    // CTO found: the status body changes the height without changing `cardPhaseKey`, nothing
    // animates it, and the next animation's `from` is the height AFTER the step - so both
    // endpoints agree with the code and the user still saw a jump.
    //
    // rAF runs after the commit's layout effects and before that frame's paint, so a sample
    // here is the height that frame is about to paint, and the last sample STRICTLY BEFORE an
    // animate() call is the last height actually on screen. That is what `from` has to equal.
    // `running` is carried on each sample so a large frame-to-frame step can be attributed to
    // an animation playing rather than counted as a snap.
    window.__cardFrames = [];
    (function sample() {
      const c = document.querySelector("#claim");
      if (c) {
        const running = typeof c.getAnimations === "function"
          && c.getAnimations().some((a) => a.id === "card-height" && a.playState === "running");
        window.__cardFrames.push([performance.now(), c.getBoundingClientRect().height, running]);
        if (window.__cardFrames.length > 6000) window.__cardFrames.splice(0, 3000);
      }
      requestAnimationFrame(sample);
    })();
  });
  await page.waitForFunction((s) => (document.querySelector("p.sr-only[role=status]")?.textContent ?? "").includes(s), PHASES[0].says, { timeout: 15000 })
    .catch(() => {});

  const anchor = await geom(page);
  t(`${W} ${speed}: the hero, the fox and the card are all on the page to measure`,
    anchor.card != null && anchor.copy != null && anchor.fox != null && anchor.h1 != null,
    JSON.stringify({ card: anchor.card, copy: anchor.copy, fox: anchor.fox, h1: anchor.h1 }));

  for (const ph of PHASES.slice(1).concat([PHASES[0]])) {
    const before = await geom(page);
    current = ph;
    // The page polls /api/status every 4s (page.tsx:489), so the new body arrives on its
    // own. Sample the card mid-flight first, THEN wait for the phase to settle.
    await page.evaluate(() => { window.__cardAnims = []; window.__cardFrames = []; });
    const t0 = Date.now();
    let reached = false;
    while (Date.now() - t0 < 9000) {
      const g = await geom(page);
      if (g.says.includes(ph.says)) { reached = true; break; }
    }
    if (!reached) { t(`${W} ${speed}: phase "${ph.name}" was reached at all`, false, `live region still: "${(await geom(page)).says.slice(0, 60)}"`); continue; }
    // SAMPLED WHEN THE ANIMATION ENDS, not after it. The old 700ms sample sat 240ms past the
    // 460ms animation, and on `degraded` the card moves AGAIN inside that gap - 683 -> 611
    // animated and finished, then 611 -> 592 as the sends reason text arrives. That second move
    // is a content change within one phase, which the ruling does not animate and should not,
    // and comparing the animation's end to a height taken after it made a correct card look like
    // a jump. `settled` is carried alongside so the row can SAY when the two differ rather than
    // hiding it.
    await page.waitForTimeout(500);
    const after = await geom(page);
    // Waited out, so `natural` below is measured after the page has stopped moving.
    await page.waitForTimeout(400);
    // THE NATURAL HEIGHT, with any of the card's own animation cancelled first. Reading the box
    // while one runs returns the interpolated value, which is exactly the defect this round is
    // about - the sweep has to measure the way the fixed code measures or it cannot see it.
    const natural = await page.evaluate(() => {
      const el = document.querySelector("#claim");
      if (!el) return null;
      if (typeof el.getAnimations === "function") {
        for (const a of el.getAnimations()) if (a.id === "card-height") a.cancel();
      }
      return el.getBoundingClientRect().height;
    });

    const moved = Math.abs(after.copy - anchor.copy) > 0.5 || Math.abs(after.fox - anchor.fox) > 0.5 || Math.abs(after.h1 - anchor.h1) > 0.5;
    const delta = Math.abs(after.card - before.card);
    transitions++;
    if (delta > 1) deltas++;
    // THE ANIMATION'S OWN ENDPOINTS, not a height measured up to four seconds earlier. The
    // page polls /api/status every 4s, so `before.card` is taken and then the card can settle
    // on its own before the phase actually flips - on the first transition it drifted 15px and
    // failed a card that was animating correctly. What the ruling asks is that the card moved
    // from its old size to its new one rather than snapping, and the keyframes say exactly
    // that without reference to when anyone looked.
    const anims = (await page.evaluate(() => window.__cardAnims ?? []))
      .map((r) => {
        const f = r && r.frames;
        if (!Array.isArray(f) || f.length < 2 || !f[0] || !f[1] || f[0].height == null || f[1].height == null) return null;
        return { from: parseFloat(f[0].height), to: parseFloat(f[1].height), opts: r.opts || {}, state: r.state, at: r.at };
      })
      .filter((a) => a && !Number.isNaN(a.from) && !Number.isNaN(a.to));
    // FOUR THINGS, NOT ONE. It must end where the card settled, start somewhere else, carry the
    // preview's own duration and easing, and have FINISHED rather than been cancelled. Any one
    // of those alone is satisfied by an animation that never played.
    // THE ANIMATION ITSELF, not a height matched from outside. Requiring `to` to equal the
    // card's final height fails a CORRECT card: on `degraded` the phase animates 683 -> 611 and
    // finishes, and then the sends-reason text arrives and the card settles at 592 inside the
    // same phase. A content change within one phase is not a phase change, the ruling does not
    // animate it, and it should not - so the final height and the animation's end legitimately
    // differ. I measured that twice, at 500ms and at 900ms, before believing it.
    //
    // What the ruling actually asks is that the phase change was animated, so that is what this
    // holds: one animation, from somewhere else, over the preview's own duration and easing, and
    // FINISHED rather than cancelled. The last of those four is the one that catches the defect
    // this round is about, and the first three are why `duration: 1` cannot pass it.
    // TIED TO A MEASURED HEIGHT AT BOTH ENDS, because round two tied them to nothing: it asked
    // only that from and to differ by a pixel, so `to = from + 10` passed the whole sweep at
    // 57/0 while the card snapped. `to` must be the height the card actually settles at with
    // no animation of ours running - measured below by cancelling first - and `from` must be
    // where it started, which for a transition out of rest is the height before the change.
    // THE LAST HEIGHT ACTUALLY ON SCREEN before the animation was created. Both ends were
    // supposed to be tied and only `to` was: `from` had to differ from `to` by a pixel and
    // nothing more, so an animation could start from a height the card was never at and the
    // row stayed green. rAF samples before the frame paints, so the last sample STRICTLY
    // earlier than the animate() call is the last painted height.
    const framesSeen = await page.evaluate(() => window.__cardFrames ?? []);
    const paintedBefore = (at) => {
      let h = null;
      for (const [t, ht] of framesSeen) { if (t < at) h = ht; else break; }
      return h;
    };
    // `from` IS A PROXY AND THE PAINTED FRAMES ARE THE AUTHORITY, which cost a round to learn.
    // Tying `from` to the last painted height caught the real defect - the recorder storing a
    // height from a commit that never reached the screen - and then went wrong the moment the
    // animator learned to CONTINUE an animation instead of restarting it: a continuation keeps
    // the original `from` keyframe and advances its clock, so it legitimately reads 616 -> 580
    // while the card is visibly at 582 and perfectly smooth. The keyframe describes the
    // animation; only the frames describe the card. So the tie is gone from here and the row
    // below does the work, on what was actually painted.
    const covering = anims.find((a) =>
      Math.abs(a.to - natural) <= 1.5
      && Math.abs(a.from - a.to) > 1
      && a.opts.duration === 460
      && a.opts.easing === "cubic-bezier(.16,1,.3,1)"
      && a.state === "finished");
    const jumped = delta > 1 && !covering;

    // THE STEP THE ANIMATION SHOULD HAVE ABSORBED, which the keyframes cannot show. Out of
    // `fault` the status body changes the card's height WITHOUT changing `cardPhaseKey`:
    // nothing animates that, the next animation's `from` is the height after it, and both
    // endpoints then agree with the code while the user saw a 20px jump.
    //
    // Scoped to the window between the phase changing and the first animate() call. A step
    // AFTER an animation has finished is the other thing - `degraded` settles 611 -> 592 as
    // the sends reason arrives, a content change inside one phase, which the ruling does not
    // animate and should not. This row must not fail that, so it does not look at it.
    // SKIPPED ONLY WHEN AN ANIMATION HELD THE CARD ACROSS BOTH SAMPLES. The first version
    // skipped any pair where EITHER end was animating, which quietly excluded the one frame
    // that matters: the step from the last un-animated height into an animation's opening
    // frame is exactly where a snap hides, and `r1` alone was enough to hide it.
    //
    // Whole transition, not just the window before the first animate(). The animator is driven
    // by the height now rather than by a phase key, so a content change inside one phase -
    // `degraded` settling as its sends reason arrives - is animated like any other and no
    // longer needs excusing.
    let preSnap = 0, preSnapPair = "";
    for (let i = 1; i < framesSeen.length; i++) {
      const [, h0, r0] = framesSeen[i - 1];
      const [, h1, r1] = framesSeen[i];
      if (r0 && r1) continue;                         // in flight at both ends: travel, not a step
      const d = Math.abs(h1 - h0);
      if (d > preSnap) { preSnap = d; preSnapPair = `${h0.toFixed(1)} -> ${h1.toFixed(1)}`; }
    }

    t(`${W} ${speed}: entering "${ph.name}" moves neither the hero copy, the fox nor the h1`, !moved,
      `copy ${before.copy}->${after.copy} fox ${before.fox}->${after.fox} h1 ${before.h1}->${after.h1}`);
    if (delta > 1) {
      t(`${W} ${speed}: the card's height animates into "${ph.name}" from its old value`, !jumped,
        anims.length === 0
          ? `${Math.round(before.card)} -> ${Math.round(after.card)} with NO height animation registered at all`
          : covering
            ? `animated ${covering.from.toFixed(1)} -> ${covering.to.toFixed(1)}px over ${covering.opts.duration}ms, finished, ending at the natural ${natural == null ? "?" : natural.toFixed(1)}px`
            : `natural ${natural == null ? "?" : Math.round(natural)}px, and no animation finished the travel to it: ${anims.map((a) => { const pb = paintedBefore(a.at); return `${a.from.toFixed(0)}->${a.to.toFixed(0)} ${a.opts.duration}ms ${a.state} (last painted before it: ${pb == null ? "none" : pb.toFixed(1)})`; }).join(", ") || "none registered"}`);
      t(`${W} ${speed}: the card never jumps on its way into "${ph.name}"`, preSnap <= 2,
        preSnap > 2
          ? `un-animated ${preSnapPair} (${preSnap.toFixed(1)}px) between two painted frames`
          : `largest step between two painted frames with no animation across both: ${preSnap.toFixed(1)}px`);
    } else {
      console.log(`  --   ${W}: "${ph.name}" changed the card by ${delta.toFixed(1)}px, too little to judge the animation`);
    }
  }

  // ===== TWO CLIPPING BOXES ON ONE AXIS =====
  // The height animation puts `overflow:hidden` on the CARD for 460ms and the design puts
  // `overflow:auto` on the `.panel` inside it. Nobody had measured what they do to each other.
  //
  // WHAT THE MEASUREMENT SAID, and it is not what the design intends. `.card.claim` carries
  // `max-height:100%`, but its containing block is `div.hero-grid`, whose height is auto - a
  // percentage max-height against an indefinite height does not resolve, so it computes to
  // `none`. The card is therefore NOT bounded, `flex:1 1 auto` on the panel has no slack to
  // take, and the panel never scrolls: with a 1200px probe inside it the panel measured
  // 1559 client and 1559 scroll, scrollTop refused to move off 0, and the CARD grew to 1702px
  // in a 900px viewport.
  //
  // That is a consequence of a decision already taken, not a new defect. The one-screen clamp
  // on the stage was deliberately removed because it swallowed content taller than the
  // viewport; without it nothing above the card has a definite height, and the design's inner
  // scroll box cannot work. So this row does not assert the design's behaviour - we chose the
  // other one - it asserts what OUR choice has to deliver: a panel too tall for the screen
  // makes the page scroll and stays reachable, rather than being swallowed.
  {
    const reach = await page.evaluate(() => {
      const card = document.querySelector("#claim");
      const panel = card && card.querySelector(":scope > .panel");
      if (!card || !panel) return { ok: false, why: card ? "no .panel inside the card" : "no card" };
      const probe = document.createElement("div");
      probe.id = "tall-probe";
      probe.style.cssText = "height:1200px;background:transparent";
      panel.appendChild(probe);
      const cardH = card.getBoundingClientRect().height;
      const panelScrolls = (() => { panel.scrollTop = 150; const m = panel.scrollTop; panel.scrollTop = 0; return m > 0; })();
      const target = probe.getBoundingClientRect().bottom + window.scrollY - window.innerHeight + 40;
      window.scrollTo(0, Math.max(0, target));
      const r = probe.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.bottom - 20);
      const hit = document.elementFromPoint(x, y);
      const out = { ok: true, cardH, viewportH: window.innerHeight, panelScrolls,
                    docScrollable: document.documentElement.scrollHeight > window.innerHeight + 1,
                    reachable: !!(hit && (hit === probe || probe.contains(hit) || hit.contains(probe))),
                    hit: hit ? (hit.id || hit.className || hit.tagName) : "nothing" };
      probe.remove();
      window.scrollTo(0, 0);
      return out;
    });
    t(`${W} ${speed}: a panel too tall for the screen is reachable, not swallowed`,
      reach.ok && reach.docScrollable && reach.reachable,
      reach.ok
        ? `card grew to ${Math.round(reach.cardH)}px in a ${reach.viewportH}px viewport, page scrollable ${reach.docScrollable}, bottom of the probe lands on ${reach.hit}; the design's inner scroll is inert here (panel scrolls: ${reach.panelScrolls})`
        : reach.why);
  }

  // The other direction. While the card animates to a shorter height the content that no longer
  // fits must be HIDDEN rather than spilling out below the card. Which box does the hiding is an
  // implementation detail - the card's own `overflow:hidden` or the panel's `auto` - so the row
  // asks the question the user can see: is anything from inside the card painting below it.
  //
  // The non-vacuity clause is the point. A card whose content fits has nothing to hide and would
  // pass this on an empty promise, so the row also requires that there IS content out of view
  // mid-flight. My first version asserted the panel's bottom fell past the card's, which is not
  // what happens: the panel is `flex:1 1 auto`, so it shrinks WITH the card and scrolls its own
  // content instead. That assertion failed on a card behaving correctly.
  {
    const clipping = await page.evaluate(async () => {
      const card = document.querySelector("#claim");
      const panel = card && card.querySelector(":scope > .panel");
      if (!card || !panel) return { ok: false, why: "no card or panel" };
      const from = card.getBoundingClientRect().height;
      const to = Math.max(120, from - 220);
      const run = card.animate([{ height: `${from}px` }, { height: `${to}px` }],
        { duration: 460, easing: "cubic-bezier(.16,1,.3,1)" });
      await new Promise((r) => setTimeout(r, 230));
      const box = card.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const hit = document.elementFromPoint(x, Math.round(box.bottom + 12));
      const out = {
        ok: true, cardH: box.height, overflow: getComputedStyle(card).overflow,
        hiddenContent: panel.scrollHeight - panel.clientHeight,
        spills: !!(hit && card.contains(hit)),
        hit: hit ? (hit.id || hit.className || hit.tagName) : "nothing",
      };
      run.cancel();
      return out;
    });
    t(`${W} ${speed}: content the card has animated past is hidden, not spilled below it`,
      clipping.ok && clipping.overflow === "hidden" && clipping.hiddenContent > 1 && !clipping.spills,
      clipping.ok
        ? `mid-flight card ${clipping.cardH.toFixed(1)}px, overflow ${clipping.overflow}, ${Math.round(clipping.hiddenContent)}px of content out of view, 12px below the card lands on ${clipping.hit}`
        : clipping.why);
  }

  t(`${W} ${speed}: no console errors across the sweep`, errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}
}
await browser.close();

// A sweep in which no phase ever changed the card's height would report every animation
// assertion as "too little to judge" and exit green having measured nothing.
t(`the sweep exercised at least one real height change (${deltas} of ${transitions} transitions did)`, deltas > 0);
console.log(`\nphase-sweep: ok=${ok} fail=${fail}`);
process.exit(fail ? 1 : 0);
