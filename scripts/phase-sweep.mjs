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

for (const [W, H] of VIEWPORTS) {
  console.log(`\n${W}x${H}`);
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  let current = PHASES[0];
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current.mutate(clone())) }));

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
      try { window.__cardAnims.push(JSON.parse(JSON.stringify(frames))); } catch { /* ignore */ }
      return original(frames, opts);
    };
  });
  await page.waitForFunction((s) => (document.querySelector("p.sr-only[role=status]")?.textContent ?? "").includes(s), PHASES[0].says, { timeout: 15000 })
    .catch(() => {});

  const anchor = await geom(page);
  t(`${W}: the hero, the fox and the card are all on the page to measure`,
    anchor.card != null && anchor.copy != null && anchor.fox != null && anchor.h1 != null,
    JSON.stringify({ card: anchor.card, copy: anchor.copy, fox: anchor.fox, h1: anchor.h1 }));

  for (const ph of PHASES.slice(1).concat([PHASES[0]])) {
    const before = await geom(page);
    current = ph;
    // The page polls /api/status every 4s (page.tsx:489), so the new body arrives on its
    // own. Sample the card mid-flight first, THEN wait for the phase to settle.
    await page.evaluate(() => { window.__cardAnims = []; });
    const t0 = Date.now();
    let reached = false;
    while (Date.now() - t0 < 9000) {
      const g = await geom(page);
      if (g.says.includes(ph.says)) { reached = true; break; }
    }
    if (!reached) { t(`${W}: phase "${ph.name}" was reached at all`, false, `live region still: "${(await geom(page)).says.slice(0, 60)}"`); continue; }
    await page.waitForTimeout(700);                       // past the 460ms the design animates
    const after = await geom(page);

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
      .map((f) => (Array.isArray(f) && f.length >= 2 && f[0] && f[1] && f[0].height != null && f[1].height != null
        ? { from: parseFloat(f[0].height), to: parseFloat(f[1].height) } : null))
      .filter((a) => a && !Number.isNaN(a.from) && !Number.isNaN(a.to));
    const covering = anims.find((a) => Math.abs(a.to - after.card) <= 1.5 && Math.abs(a.from - a.to) > 1);
    const jumped = delta > 1 && !covering;

    t(`${W}: entering "${ph.name}" moves neither the hero copy, the fox nor the h1`, !moved,
      `copy ${before.copy}->${after.copy} fox ${before.fox}->${after.fox} h1 ${before.h1}->${after.h1}`);
    if (delta > 1) {
      t(`${W}: the card's height animates into "${ph.name}" from its old value`, !jumped,
        anims.length === 0
          ? `${Math.round(before.card)} -> ${Math.round(after.card)} with NO height animation registered at all`
          : covering
            ? `animated ${covering.from.toFixed(1)} -> ${covering.to.toFixed(1)}px`
            : `${Math.round(after.card)}px settled, but no animation ended there: ${anims.map((a) => `${a.from.toFixed(0)}->${a.to.toFixed(0)}`).join(", ")}`);
    } else {
      console.log(`  --   ${W}: "${ph.name}" changed the card by ${delta.toFixed(1)}px, too little to judge the animation`);
    }
  }

  t(`${W}: no console errors across the sweep`, errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}
await browser.close();

// A sweep in which no phase ever changed the card's height would report every animation
// assertion as "too little to judge" and exit green having measured nothing.
t(`the sweep exercised at least one real height change (${deltas} of ${transitions} transitions did)`, deltas > 0);
console.log(`\nphase-sweep: ok=${ok} fail=${fail}`);
process.exit(fail ? 1 : 0);
