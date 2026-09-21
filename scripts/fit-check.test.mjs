/**
 * THE STALL PATH IS WHAT MAKES THE EVENT WAIT SAFE, so it has a row of its own and not only the
 * mutant that was run once by hand. fit-check.mjs replaced two sleeps with waits for the page's
 * own events (LIVE on screen; fonts and theme on a subpage), which halves the script. The risk
 * that trade introduces is a page that never reaches LIVE being measured anyway - on the
 * CHECKING card, a different height - and reported as the fit. This row drives the real script
 * against a page that never says LIVE and asserts two things: every context is NAMED as a
 * stall, and NONE of them is measured.
 *
 * It spawns the script rather than importing it, because the script runs on import and its
 * verdict is its exit code (the live-probe row's reason, and the same shape). The stub page
 * carries the nav and view test-ids the script clicks and a theme attribute on the root, so the
 * mutant this row exists for - fall through the stall and measure - produces rows rather than a
 * crash, and the row fails on the rows.
 *
 * Playwright is not a dependency of this package (the browser jobs install it), so where it
 * cannot be resolved this row SKIPS by name rather than passing: the ui job runs it after the
 * fit check itself, and deploy/z3/tests/suites/repo.sh holds that line in place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

let playwright = null;
try { playwright = await import("playwright"); } catch { /* not installed here */ }

const PAGE = `<!doctype html><html data-theme="paper"><body>
<div class="stage">
  <nav>${["claim", "status", "analytics", "tools"].map((v) => `<button data-testid="nav-${v}">${v}</button>`).join("")}</nav>
  ${["claim", "status", "analytics", "tools"].map((v) => `<section data-testid="view-${v}" style="display:block">CHECKING ${v}</section>`).join("")}
  <p>Checking the faucet's status. Reading the node and the wallet.</p>
</div></body></html>`;

test("fit-check: a page that never reaches LIVE is named as a stall, and not measured", { skip: playwright ? false : "playwright is not installed here; the ui job runs this row after the fit check" }, async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    // ASYNC, NOT spawnSync: the stub server lives in this process's event loop, and a
    // synchronous spawn would block it, so the child's first navigation would hang on a server
    // that can never answer (the first version of this row did exactly that, 30 s per context).
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["scripts/fit-check.mjs", `http://127.0.0.1:${port}`], {
        env: { ...process.env, FIT_LIVE_TIMEOUT_MS: "200" },
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      const killer = setTimeout(() => child.kill("SIGKILL"), 180_000);
      child.on("close", (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }); });
    });
    const out = `${run.stdout}\n${run.stderr}`;
    // NAMED: the run fails, says why, and says how many. Six sizes x two themes x two pointers is
    // the whole matrix, and a stall count under that would mean some contexts were let through.
    assert.equal(run.status, 1, `exit ${run.status}, expected 1\n${out.slice(-1500)}`);
    assert.match(out, /FAIL - 24 context\(s\) never reached LIVE/, out.slice(-1500));
    assert.match(out, /1024x768 ink coarse: the page never reached LIVE within 200 ms/, "the last context is named with its size, theme and pointer");
    // NOT MEASURED: no combination row at all. A measured row here is the CHECKING card being
    // reported as a fit, which is the failure this row exists to catch.
    const measured = out.split("\n").filter((l) => /^\d+x\d+ (paper|ink) /.test(l));
    assert.deepEqual(measured, [], `contexts that never reached LIVE were measured anyway:\n  ${measured.slice(0, 4).join("\n  ")}`);
    // And the count guard did not have to be the one to say so: the stall verdict comes first.
    assert.doesNotMatch(out, /measured 0 of \d+ planned combinations/, "the stall verdict must fire before the planned-count guard, or the reason is lost");
  } finally {
    server.close();
  }
});

test("fit-check: the shipped LIVE budget is 8 s, and the knob above only lowers it for this row", () => {
  // The override is set in every spawned case, which is how a shipped value goes unmeasured; the
  // default is anchored here, from the source, so a change to it is deliberate.
  const src = readFileSync("scripts/fit-check.mjs", "utf8");
  assert.match(src, /const LIVE_TIMEOUT_MS = Number\(process\.env\.FIT_LIVE_TIMEOUT_MS\) \|\| 8000;/);
});
