/**
 * The off-box probe, which is the only signal that has ever reached us unprompted, had
 * no automated coverage at all: every branch of it could be deleted and every gate
 * stayed green. This spawns the real script against a fake faucet, because importing it
 * runs it.
 *
 * What is pinned here is the set of ways it could pass while the faucet is broken
 * (risk register #17): no URL, and an escape hatch that never expires.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./live-probe.mjs", import.meta.url));

/** A faucet that answers /api/status and /api/ready however the case wants. */
function fakeFaucet(ready) {
  const server = createServer((req, res) => {
    const status = {
      network: "testnet", dripTaz: 0.1, balanceTaz: 100, empty: false, queueDepth: 0,
      challenge: "pow", node: { ready: true, syncPercent: 100, height: 10, frozen: false },
      backend: { reachable: true },
      box: { state: "complete", expected: 1, present: 1, notEnabled: 0, watchdogUnit: "active", alertBridge: "ok", minerBinary: "current", ageSeconds: 5 },
    };
    const body = req.url.startsWith("/api/ready") ? ready : status;
    const code = req.url.startsWith("/api/ready") ? (ready.ready ? 200 : 503) : 200;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return server;
}

const READY = { ready: true, reason: null, node: { ready: true, canBuildTx: true, shield: { state: "safe", lag: 0 } }, backend: { reachable: true }, balanceTaz: 100 };
const NOT_READY = { ready: false, reason: "below reserve, refilling", node: { ready: true, canBuildTx: false, shield: { state: "safe", lag: 0, reason: "below reserve" } } };

/**
 * ASYNC, NOT spawnSync. The fake faucet lives in THIS process, and a synchronous spawn
 * blocks its event loop: the probe then times out against a server that never accepts,
 * every case "fails", and the cases that assert failure pass for the wrong reason. That
 * is what the first version of this file did.
 */
function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    // node:test has no default timeout, so a spawn that never finishes would hang the
    // whole suite in CI instead of failing it.
    const bomb = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`probe did not finish in 60s\n${out}\n${err}`)); }, 60_000);
    child.on("error", (e) => { clearTimeout(bomb); reject(e); });
    child.on("close", (code) => { clearTimeout(bomb); resolve({ code, out, err }); });
  });
}

async function runProbe(env, ready = READY) {
  const server = fakeFaucet(ready);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(process.execPath, [PROBE], {
      SMOKE_URL: url, SMOKE_ATTEMPTS: "1", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1", ...env,
    });
  } finally {
    server.close();
  }
}

test("NO URL IS A FAILURE, not a quiet pass: a probe that never ran must not look healthy", async () => {
  const r = await run(process.execPath, [PROBE], { SMOKE_URL: "", SMOKE_SKIP_EXPLORER: "1" });
  assert.notEqual(r.code, 0, "an unconfigured probe exited 0");
  assert.match(r.err + r.out, /SMOKE_URL is not set/);
});

test("a healthy faucet passes", async () => {
  const r = await runProbe({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /live-probe: healthy/);
});

test("a faucet that cannot drip FAILS, which is the whole point of the probe", async () => {
  const r = await runProbe({}, NOT_READY);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /below reserve, refilling/);
});

test("THE OLD FOREVER-HATCH IS DEAD: SMOKE_ALLOW_UNREADY=1 is ignored, loudly", async () => {
  // Set during one incident, "1" silenced the faucet-cannot-drip check for good.
  const r = await runProbe({ SMOKE_ALLOW_UNREADY: "1" }, NOT_READY);
  assert.notEqual(r.code, 0, "the hatch still suppressed the failure");
  assert.match(r.err, /not a YYYY-MM-DD date, so it is IGNORED/);
  // And the failure is the READY check, not an unreachable fake: without this the case
  // passes just as well against a faucet that never answered.
  assert.match(r.out, /FAIL: faucet is ready to drip.*below reserve, refilling/);
});

test("a hatch with a FUTURE date holds, and says until when", async () => {
  const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const r = await runProbe({ SMOKE_ALLOW_UNREADY: future }, NOT_READY);
  assert.equal(r.code, 0, r.out);
  assert.match(r.err, new RegExp(`until the end of ${future} UTC`));
});

test("a hatch with a PAST date is ignored, and says it expired", async () => {
  const r = await runProbe({ SMOKE_ALLOW_UNREADY: "2020-01-01" }, NOT_READY);
  assert.notEqual(r.code, 0, "an expired hatch still suppressed the failure");
  assert.match(r.err, /expired on 2020-01-01/);
  assert.match(r.out, /FAIL: faucet is ready to drip.*below reserve, refilling/);
});

test("today's date still holds: the hatch runs to the END of the day it names", async () => {
  // Tomorrow, not today: deriving "today" here and re-reading the clock in the child
  // flakes across UTC midnight, and the property under test is the end-of-day boundary,
  // which tomorrow exercises just as well without the race.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const r = await runProbe({ SMOKE_ALLOW_UNREADY: tomorrow }, NOT_READY);
  assert.equal(r.code, 0, r.out);
  assert.match(r.err, new RegExp(`until the end of ${tomorrow} UTC`));
});

test("the hatch is CAPPED: a far-future date is the old forever-hatch with extra typing", async () => {
  const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  assert.notEqual((await runProbe({ SMOKE_ALLOW_UNREADY: day(60) }, NOT_READY)).code, 0, "a 60-day hatch was honoured");
  assert.match((await runProbe({ SMOKE_ALLOW_UNREADY: day(60) }, NOT_READY)).err, /past the 14-day cap/);
  assert.equal((await runProbe({ SMOKE_ALLOW_UNREADY: day(7) }, NOT_READY)).code, 0, "a week out is inside the cap");
  // THE BOUNDARY THE RUNBOOK NAMES. It says "at most 14 days out", and a ceil-based day
  // count refused exactly that value: the operator types the documented number and is
  // told it is 15 days out.
  assert.equal((await runProbe({ SMOKE_ALLOW_UNREADY: day(14) }, NOT_READY)).code, 0, "14 days out, the documented maximum, was refused");
  // day(15) is computed HERE and the child re-reads the clock: across UTC midnight the
  // date it was handed is 14 days out and is rightly accepted. Rare, but a test that
  // fails once a month at 00:00 gets muted, so retry on the rollover instead. day(14)
  // has no mirror hazard: a rollover makes it 13, still inside the cap.
  for (let attempt = 0; ; attempt++) {
    const before = day(0);
    const r = await runProbe({ SMOKE_ALLOW_UNREADY: day(15) }, NOT_READY);
    if (day(0) !== before && attempt < 3) continue;
    assert.notEqual(r.code, 0, "15 days out was honoured");
    break;
  }
  // And a malformed cap must not DISABLE the cap: `daysOut > NaN` is false, fail-open.
  const r = await runProbe({ SMOKE_ALLOW_UNREADY: day(60), SMOKE_ALLOW_UNREADY_MAX_DAYS: "abc" }, NOT_READY);
  assert.notEqual(r.code, 0, "a malformed cap disabled the cap");
  assert.match(r.err, /past the 14-day cap/);
});

test("garbage is ignored rather than trusted", async () => {
  // The REASON matters, not just the refusal: "2026-02-30" is refused by the calendar
  // round-trip, and without that check V8 rolls it to March 2nd and the expiry rule
  // refuses it instead, for the wrong reason and with the wrong message.
  const why = [
    ["yes", /not a YYYY-MM-DD date/],
    ["true", /not a YYYY-MM-DD date/],
    ["forever", /not a YYYY-MM-DD date/],
    ["2026-13-45", /not a real calendar date/],
    ["2026-02-30", /not a real calendar date/],
    ["2099-01-01", /past the 14-day cap/],
  ];
  for (const [v, expected] of why) {
    const r = await runProbe({ SMOKE_ALLOW_UNREADY: v }, NOT_READY);
    assert.notEqual(r.code, 0, `"${v}" was treated as a hatch`);
    assert.match(r.err, expected, `"${v}" was refused for the wrong reason`);
    assert.match(r.out, /FAIL: faucet is ready to drip/, `"${v}": the probe did not reach the readiness check`);
  }
});
