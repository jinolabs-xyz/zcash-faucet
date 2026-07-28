// Browser smoke: loads the real page and drives a claim the way a person
// does, so a UI regression cannot pass every gate we have. The HTTP smoke
// (e2e-smoke.mjs) proves the API works. Nothing before this proved that the
// page wired to that API works.
//
//   npm run build
//   node scripts/fake-zallet.mjs &
//   FAUCET_SENDER=zallet ZALLET_RPC_URL=http://127.0.0.1:28299/ ZALLET_ACCOUNT=fake-account \
//   ZALLET_ADDRESS=utest1fake ZALLET_MIN_CONF=0 FAUCET_CHALLENGE=pow FAUCET_POW_BITS=12 \
//   RATE_LIMIT_SALT=ui-smoke PORT=3120 npm start
//   npm i --no-save playwright@1.62.0 && npx playwright install chromium
//   (the same version ci.yml pins, so a local repro cannot diverge from CI)
//   UI_SMOKE_URL=http://localhost:3120 node scripts/ui-smoke.mjs
//
// Playwright is installed with --no-save rather than living in package.json:
// it is a CI-only concern, and keeping it out means `npm ci` stays fast for
// everyone and production installs no browser tooling. Invoked as a plain
// node script for the same reason, no shared package.json entry needed.
import { chromium } from "playwright";

const BASE = (process.env.UI_SMOKE_URL ?? "http://localhost:3120").replace(/\/$/, "");
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
async function checkAppearance(page) {
  // The masthead mark, same identity as the favicon. aria-hidden by design, so
  // assert its presence, not an accessible name.
  ok("the masthead mark renders", await page.locator("svg.brand-mark").first().isVisible());

  // The LIVE dot paints the state, not a fixed colour: --color-live only when the
  // faucet is serviceable. Compare the dot's resolved background to the token
  // itself, not a hardcoded rgb, so a theme edit cannot make this assertion lie.
  const [dotBg, liveToken] = await page.evaluate(() => {
    const dot = [...document.querySelectorAll("span[aria-hidden]")].find((el) => el.style.animation.includes("pulse"));
    // Resolve the token in the DOT's own context, not on body: the theme tokens
    // are scoped to the .app wrapper, so a body-level probe reads the :root
    // default and would compare the dot against the wrong theme's value.
    const probe = document.createElement("span");
    probe.style.color = "var(--color-live)";
    (dot?.parentElement ?? document.body).appendChild(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return [dot ? getComputedStyle(dot).backgroundColor : "no dot", token];
  });
  ok("the LIVE dot carries the --color-live state colour", dotBg === liveToken, `${dotBg} vs ${liveToken}`);

  // Reduced-motion, BOTH directions. `reduce == halted` alone would also pass if
  // the animation had simply stopped existing, a live risk since the dot was
  // refactored, so the pair pins it: animated by default, none under reduce. The
  // global `* { animation: none !important }` beats the inline style here, which
  // is the exact cascade fact this proves is still working.
  const dotAnim = () =>
    page.evaluate(() => {
      const dot = [...document.querySelectorAll("span[aria-hidden]")].find((el) => el.style.animation.includes("pulse"));
      return dot ? getComputedStyle(dot).animationName : "no dot";
    });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  ok("the dot animates by default", (await dotAnim()) === "pulse");
  await page.emulateMedia({ reducedMotion: "reduce" });
  ok("reduced-motion halts the dot", (await dotAnim()) === "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Text contrast: sample a resting link and compute its WCAG ratio against the
  // first opaque background behind it. 4.5 is the AA floor for body text, and
  // resting accent links were under it until the per-theme token landed (#96/#99).
  const ratio = await page.evaluate(() => {
    const a = document.querySelector("a");
    if (!a) return null;
    const lum = (c) => {
      const [r, g, b] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((n) => {
        const s = Number(n) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const opaque = (c) => c && !/rgba\(.*,\s*0\)$|transparent/.test(c);
    let el = a;
    let bg = getComputedStyle(el).backgroundColor;
    while (el && !opaque(bg)) {
      el = el.parentElement;
      bg = el ? getComputedStyle(el).backgroundColor : "rgb(255, 255, 255)";
    }
    const [hi, lo] = [lum(getComputedStyle(a).color), lum(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  });
  ok("resting link text meets WCAG AA", ratio != null && ratio >= 4.5, ratio ? `${ratio.toFixed(2)}:1` : "no link found");
}

// The 404 must wear the site chrome, not Next's bare default. A broken not-found
// route renders as the framework default, which has no mark, so this fails on it.
async function check404(page, base) {
  const res = await page.goto(`${base}/this-route-does-not-exist`, { waitUntil: "networkidle" });
  ok("an unknown path returns a real 404", res?.status() === 404, String(res?.status()));
  ok("the 404 wears the site chrome", await page.locator("svg.brand-mark").first().isVisible());
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();

// Anything the page logs as an error, or any uncaught exception, fails the run.
// A React hydration mismatch or a bad import surfaces here and nowhere else.
const problems = [];
page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ""}`));

try {
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
  ok("page renders its heading", (await page.textContent("body")).includes("Get free testnet ZEC"));
  ok("status bar reached the API", /balance\s/.test(await page.textContent("body")));

  // Visual + a11y checks before the claim flow, while the home page is loaded.
  await checkAppearance(page);

  // Generate-then-claim, the flow #31 broke for every visitor: the button read
  // the address from the wrong field and substituted a synthesized one that
  // checksum validation refuses. Driving the button, not the API, is what
  // catches it.
  await page.getByRole("button", { name: "Generate a test address" }).first().click();
  // Settle on a filled field OR a visible error, then assert. Both #31 shapes
  // then fail by name rather than timing out: reading the wrong response field
  // leaves the box empty today, and the older synthesized fallback filled it
  // with a too-short address.
  await page
    .waitForFunction(
      () => (document.querySelector("input.input")?.value ?? "").length > 0 || /Couldn.t (generate|reach)/.test(document.body.innerText),
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  const generated = await page.locator("input.input").first().inputValue();
  ok("the generate button yields a full unified address", generated.length > 100, `${generated.length} chars`);
  if (generated.length <= 100) throw new Error("generate did not produce a usable address, skipping the claim it feeds");
  await page.locator("button.btn-primary").first().click();
  await page.getByText("Sent ✓").waitFor({ timeout: 120_000 });
  ok("a generated address is accepted by the faucet (#31)", true);
  await page.getByRole("button", { name: /Another address/ }).click();

  const address = await freshAddress();
  await page.locator("input.input").first().fill(address);
  const submit = page.locator("button.btn-primary").first();
  ok("the claim button is offered", await submit.isEnabled(), (await submit.textContent())?.trim());
  await submit.click();

  // Covers the in-page proof-of-work worker as well as the claim round trip.
  await page.getByText("Sent ✓").waitFor({ timeout: 120_000 });
  ok("a claim driven through the UI succeeds", true);
  const success = await page.textContent("body");
  ok("success names the address it sent to", success.includes(address.slice(-6)));
  ok("success shows a txid", /[0-9a-f]{10}/.test(success));

  await page.getByRole("button", { name: /Copy txid/ }).click();
  await page.waitForTimeout(300);
  const copied = String(await page.evaluate(() => navigator.clipboard.readText().catch(() => "")));
  ok("copy txid puts a 64-hex txid on the clipboard", /^[0-9a-f]{64}$/.test(copied), copied.slice(0, 16));

  // Assert the clean-console guarantee on the whole claim flow BEFORE the 404
  // check, which deliberately loads a 404 and would otherwise pollute this.
  ok("no page errors, console errors or failed requests", problems.length === 0, problems.slice(0, 3).join(" | "));

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
