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
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
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
});

test("today's date still holds: the hatch runs to the END of the day it names", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await runProbe({ SMOKE_ALLOW_UNREADY: today }, NOT_READY);
  assert.equal(r.code, 0, r.out);
});

test("garbage is ignored rather than trusted", async () => {
  for (const v of ["yes", "true", "forever", "2026-13-45"]) {
    const r = await runProbe({ SMOKE_ALLOW_UNREADY: v }, NOT_READY);
    assert.notEqual(r.code, 0, `"${v}" was treated as a hatch`);
    assert.match(r.err, /IGNORED/);
  }
});
