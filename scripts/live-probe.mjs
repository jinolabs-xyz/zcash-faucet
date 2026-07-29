// Probes a LIVE faucet from outside the box: /api/status and /api/ready only,
// never a claim. The e2e smoke (e2e-smoke.mjs) drains a drip and burns a
// cooldown slot every run, which is right for CI against a throwaway server
// and wrong for production monitoring on a schedule.
//
// The on-box watchdog and metrics timer cannot report a dead box or a broken
// domain. This can, because it runs somewhere else:
//
//   SMOKE_URL=https://faucet.example.org npm run smoke:live
//
// Exit 0 means the faucet is up and ready to drip. Ready saying no is a real
// answer and fails the probe with the app's own reason, because a faucet that
// cannot drip is what monitoring exists to catch. During a planned un-ready
// window (initial sync on a fresh box), set SMOKE_ALLOW_UNREADY=1 to keep the
// schedule green while still failing on unreachable or broken responses.
const BASE = (process.env.SMOKE_URL ?? "").replace(/\/$/, "");
const ALLOW_UNREADY = process.env.SMOKE_ALLOW_UNREADY === "1";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15000);

if (!BASE) {
  console.error("SMOKE_URL is not set, nothing to probe");
  process.exit(2);
}

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "ok" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
};

async function probe(path) {
  const started = Date.now();
  try {
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, body: null, ms: Date.now() - started, err: err.message };
  }
}

// The explorer property (#179). #168 switched the tx link to cipherscan for one
// reason: blockexplorer.one rendered a page for ANY 64-hex string, so the link
// reassured instead of confirming (#71). Nothing in CI pinned that, so the day
// cipherscan decides an unknown txid deserves a friendly "not found yet" page we
// silently inherit the bug we changed dependency to escape, and no test goes red.
//
// Only ONE of these two assertions can fail the probe, and it is deliberate:
//
//   unknown txid renders   -> FAIL. The property is gone. Unambiguous.
//   real txid 404s         -> cannot-verify. A hard-coded txid ages, and a pruning
//                             or reorged explorer would fail us for the wrong reason.
//   explorer unreachable   -> cannot-verify. Otherwise a cipherscan outage pages an
//                             operator about a faucet that is perfectly healthy,
//                             which is the false-alarm cost this probe must not add.
//
// Both UAs, because a 404 that only happens to curl is worthless: the person
// clicking the link is in a browser, and that is the case that has to hold.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
// Measured 2026-07-29, both UAs: this 404s, and the real txid below 200s.
const UNKNOWN_TXID = "0000000000000000000000000000000000000000000000000000000000000000";
const REAL_TXID = "cab68e6abaa82b4c64931cedbc96f80b606fb7456005ef3c5d443f9b59eb9510";

/**
 * The shipped URL builder, loaded at call time rather than imported at the top.
 *
 * It has to be the shipped one: a URL this script templates itself would keep
 * passing while the real builder broke, which is the #179 failure in miniature.
 * But explorer.ts is TypeScript and this is a monitoring script, so the import
 * needs Node's type stripping. Loading it dynamically means an old Node on a
 * monitoring host costs us THIS CHECK and nothing else, instead of exiting
 * non-zero and reporting a healthy faucet as broken. explorer.ts imports nothing
 * itself, so this pulls in no config.
 */
async function loadExplorerTxUrl() {
  try {
    return (await import("../src/lib/zcash/explorer.ts")).explorerTxUrl;
  } catch (err) {
    console.log(`cannot-verify: could not load the shipped explorer URL builder (${err.message})`);
    return null;
  }
}

/** Fetch an explorer tx page. Returns 0 for unreachable. */
async function explorerHit(explorerTxUrl, txid, ua) {
  const url = explorerTxUrl(txid);
  try {
    const res = await fetch(url, {
      headers: ua ? { "user-agent": ua } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
    return res.status;
  } catch {
    return 0;
  }
}

async function checkExplorerProperty() {
  const explorerTxUrl = await loadExplorerTxUrl();
  if (!explorerTxUrl) return;

  // The host, not the template: explorerTxUrl percent-encodes what it is given,
  // so printing a "{txid}" placeholder through it comes out as %7Btxid%7D.
  // This asserts the property of the explorer THIS CHECKOUT is configured for, so
  // a deploy that overrides the template should set the same var here.
  console.log(`\nexplorer property (#179): ${new URL(explorerTxUrl(UNKNOWN_TXID)).host}`);

  const unknown = await Promise.all([
    explorerHit(explorerTxUrl, UNKNOWN_TXID, null),
    explorerHit(explorerTxUrl, UNKNOWN_TXID, BROWSER_UA),
  ]);
  const [dflt, browser] = unknown;
  const unreachable = dflt === 0 && browser === 0;

  if (unreachable) {
    // Not a failure. Absence of evidence is not evidence that the property broke.
    console.log(`cannot-verify: explorer unreachable, so the 404 property is unchecked this run`);
  } else {
    // 404 is the pass. Anything that renders means an invented txid gets a page,
    // which is exactly #71. A 5xx is the explorer being broken, not lying, so it
    // reads as cannot-verify per source rather than as a property violation.
    const verdict = (code) => (code === 404 ? "ok" : code === 0 || code >= 500 ? "cannot-verify" : "RENDERED");
    const bad = [dflt, browser].some((c) => verdict(c) === "RENDERED");
    ok(
      "an unknown txid does NOT render an explorer page",
      !bad,
      `default-UA ${dflt} ${verdict(dflt)}, browser-UA ${browser} ${verdict(browser)}`,
    );
  }

  // Positive direction, cannot-verify on failure by design: this txid will age.
  const real = await explorerHit(explorerTxUrl, REAL_TXID, BROWSER_UA);
  if (real === 200) {
    console.log(`ok: a real txid renders (${REAL_TXID.slice(0, 12)}… 200), so the negative above means something`);
  } else {
    console.log(
      `cannot-verify: the pinned real txid answered ${real}, which is a stale fixture or a pruning ` +
        `explorer rather than a broken property. Repin it from a recent claims.txid.`,
    );
  }
}

const status = await probe("/api/status");
ok("GET /api/status answers 200", status.status === 200, status.err ?? `status ${status.status}, ${status.ms}ms`);
const statusUsable = status.status === 200 && !!status.body;
if (!statusUsable) {
  // Recorded, not exited on. This used to exit(1) here, which meant a dead faucet
  // also skipped the explorer property below, and those two facts are unrelated
  // (#179). Exit code is unchanged: the failure above still lands at the bottom.
  console.log(`  ${BASE} is unreachable or broken, skipping the assertions that need its body`);
}
if (statusUsable) {
  ok("status body is the faucet's", typeof status.body.balanceTaz !== "undefined" && !!status.body.network, `network ${status.body.network}`);
  ok("backend reachable from the app", status.body.backend?.reachable === true);
  console.log(
    `  balance ${status.body.balanceTaz ?? "unknown"} TAZ` +
      ` · queue ${status.body.queueDepth ?? "?"}` +
      ` · reserve ${status.body.reserve?.refilling ? "topping up" : "ok"}` +
      ` · ${status.ms}ms`,
  );

  const ready = await probe("/api/ready");
  if (ready.status === 200) {
    ok("GET /api/ready says a drip can be served", true, `${ready.ms}ms`);
  } else if (ready.status === 503 && ready.body) {
    const reason = ready.body.reason ?? ready.body.error ?? JSON.stringify(ready.body);
    ok("faucet is ready to drip", ALLOW_UNREADY, `app says not ready: ${reason}${ALLOW_UNREADY ? ", allowed by SMOKE_ALLOW_UNREADY" : ""}`);
  } else {
    ok("GET /api/ready answers", false, ready.err ?? `status ${ready.status}`);
  }
}

await checkExplorerProperty();

console.log(failures === 0 ? "\nlive-probe: healthy" : `\nlive-probe: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
