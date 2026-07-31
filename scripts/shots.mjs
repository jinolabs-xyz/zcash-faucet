// Regenerate the README screenshots.
//
//   node scripts/shots.mjs --base=https://zcashfaucet.jinolabs.xyz --only=ready-ink,ready-paper,panel,donate,fund,terms
//   node scripts/shots.mjs --base=http://localhost:3120 --only=topping-up,success-receipt
//   node scripts/shots.mjs --list
//
// WHY THIS IS A SCRIPT. Every image in the README went stale in a day, because they
// were taken by hand and nobody retakes a set of screenshots by hand. This makes the
// answer to "the UI changed" one command instead of an afternoon.
//
// 2360x1720 is the existing set's size: a 1180x860 viewport at deviceScaleFactor 2.
// Matching it exactly is not fussiness, the README lays them out in a table and a
// different aspect ratio makes the whole page ragged.
//
// WHICH SOURCE FOR WHICH SHOT, and this is the part with a rule behind it. Anything
// showing live status or a real address comes from PRODUCTION, because a README that
// illustrates "these numbers come off our own node" with numbers that came off a fake
// wallet is doing the exact substitution this project spends its time removing. The
// local harness is only for states production is genuinely not in, and there are two:
// topping-up needs a reserve below target, and the success receipt needs a claim,
// which against production would spend a real drip and publish a real txid.
//
// Needs `npm i --no-save playwright@1.62.0` and `npx playwright install chromium`.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "docs/screenshots";
const WIDTH = 1180;
const HEIGHT = 860;

const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") ?? d;
const BASE = (arg("base", "http://localhost:3120")).replace(/\/$/, "");

/**
 * `theme` is applied through the real footer control rather than by writing a class,
 * so a shot cannot show a theme the page cannot actually reach.
 */
const SHOTS = {
  "ready-ink": { path: "/", theme: "ink", note: "front page, dark" },
  "ready-paper": { path: "/", theme: "paper", note: "front page, light" },
  // Clipped to the masthead, strip and panel rather than the whole viewport. At full
  // height the instrument is a thin band across the top quarter and the hero takes the
  // eye, which buries the one image that shows the numbers come off our own node. This
  // is a new figure rather than a replacement, so it is not in a table with the others
  // and a different aspect ratio costs nothing.
  panel: { path: "/", theme: "ink", panel: true, clipTo: "#live-panel", note: "the details panel, open" },
  "topping-up": { path: "/", theme: "ink", note: "reserve refilling while still serving" },
  "success-receipt": { path: "/", theme: "ink", claim: true, note: "a completed claim" },
  donate: { path: "/donate", theme: "ink", note: "shielded donation address" },
  fund: { path: "/fund", theme: "ink", note: "mainnet upkeep address" },
  terms: { path: "/terms", theme: "ink", note: "terms of service" },
};

if (process.argv.includes("--list")) {
  for (const [k, v] of Object.entries(SHOTS)) console.log(`  ${k.padEnd(17)} ${v.path.padEnd(9)} ${v.note}`);
  process.exit(0);
}

const only = arg("only", "").split(",").filter(Boolean);
const wanted = only.length ? only : Object.keys(SHOTS);
const unknown = wanted.filter((w) => !(w in SHOTS));
if (unknown.length) {
  console.error(`unknown shot(s): ${unknown.join(", ")}. Run with --list.`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  // Freeze the pulse on the LIVE dot. It is mid-animation at an arbitrary opacity
  // otherwise, so two runs of this script produce different bytes for an identical
  // page and every regeneration looks like a change.
  reducedMotion: "reduce",
});
const page = await ctx.newPage();

async function setTheme(want) {
  const isInk = () => page.evaluate(() => document.querySelector(".app")?.classList.contains("ink") ?? false);
  if ((want === "ink") !== (await isInk())) await page.getByRole("button", { name: /Switch to/ }).click();
  await page.waitForFunction((w) => (document.querySelector(".app")?.classList.contains("ink") ?? false) === (w === "ink"), want);
}

let failed = 0;
for (const name of wanted) {
  const s = SHOTS[name];
  try {
    await page.goto(BASE + s.path, { waitUntil: "networkidle", timeout: 60_000 });
    await setTheme(s.theme);

    if (s.panel) {
      await page.getByRole("button", { name: /More details/ }).click();
      await page.waitForTimeout(400);
    }

    if (s.claim) {
      await page.getByRole("button", { name: "Generate a test address" }).first().click();
      await page.waitForFunction(() => (document.querySelector("input.input")?.value ?? "").length > 40, null, { timeout: 30_000 });
      await page.locator("button.btn-primary").first().click();
      await page.getByText("Sent ✓").waitFor({ timeout: 120_000 });
    }

    // Settle the status poll so the strip is populated rather than caught mid-"–".
    await page.waitForTimeout(900);

    let clip;
    if (s.clipTo) {
      const box = await page.locator(s.clipTo).boundingBox();
      if (!box) throw new Error(`clip target ${s.clipTo} is not on the page`);
      // From the very top, so the shot keeps the masthead and the status strip. The
      // panel alone is a row of numbers with nothing saying whose numbers they are.
      clip = { x: 0, y: 0, width: WIDTH, height: Math.ceil(box.y + box.height) };
    }
    await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
    console.log(`  ok   ${name}.png`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  }
}

await browser.close();
console.log(failed ? `\n${failed} shot(s) failed` : "\nall shots taken");
process.exit(failed ? 1 : 0);
