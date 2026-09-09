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
import { createServer as createTlsServer } from "node:https";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

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

const STATUS_BODY = {
  network: "testnet", dripTaz: 0.1, balanceTaz: 100, empty: false, queueDepth: 0, challenge: "pow",
  backend: { reachable: true },
  node: { ready: true, syncPercent: 100, height: 10, frozen: false },
  box: { state: "complete", expected: 1, present: 1, notEnabled: 0, watchdogUnit: "active", alertBridge: "ok", minerBinary: "current", ageSeconds: 5 },
};
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

/* --------------------------------------- the certificate, which only an outside probe sees (#18) */

/** A self-signed cert valid for `days`, or null when this machine has no openssl.
 *  A NULL HERE USED TO SKIP THREE TESTS GREEN, and with it every behavioural assertion
 *  about the certificate: with a broken openssl on PATH, deleting the certificate check
 *  from the probe's exit code left `npm test` at 0 failures. CI has openssl, so the
 *  coverage is real there and the tests say so rather than quietly standing down. Set
 *  SMOKE_TEST_ALLOW_NO_OPENSSL=1 to skip on a machine that genuinely has none. */
function selfSigned(days) {
  const dir = mkdtempSync(join(tmpdir(), "probe-tls-"));
  const key = join(dir, "k.pem"), crt = join(dir, "c.pem");
  const r = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt,
    "-days", String(days), "-subj", "/CN=localhost",
    // A SAN for the address the tests actually connect to, so a cert put in
    // NODE_EXTRA_CA_CERTS can be TRUSTED rather than failing on the name instead.
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return { key: readFileSync(key), cert: readFileSync(crt), certPath: crt };
}

/** A certificate that expired in 2020, read from the repo. tls.connect verifies by
 *  default, so an expired certificate fails the HANDSHAKE - it never reaches the
 *  days-left branch, which is where the runbook sentence lives, and that branch needs a
 *  real expired certificate to test.
 *
 *  FROM A FILE, not from openssl. Generating one needs `req -not_before/-not_after`,
 *  which did not exist before OpenSSL 3.5; ubuntu-latest, node:22 and this repo's harness
 *  image all ship 3.0.x, so the generated version skipped on every machine that runs the
 *  gate - and with it, the whole handshake-failure branch could be deleted with npm test
 *  still green. See scripts/fixtures/README.md. */
function expiredCert() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
  return {
    key: readFileSync(join(dir, "expired-localhost.key.pem")),
    cert: readFileSync(join(dir, "expired-localhost.crt.pem")),
  };
}

async function runTlsProbe(days, env = {}) {
  const pair = selfSigned(days);
  if (!pair) {
    if (process.env.SMOKE_TEST_ALLOW_NO_OPENSSL === "1") return null;
    assert.fail(
      "openssl did not produce a test certificate, so every behavioural check on the " +
      "certificate would have been skipped and npm test would still be green. Install " +
      "openssl, or set SMOKE_TEST_ALLOW_NO_OPENSSL=1 to accept the loss of coverage.",
    );
  }
  const server = createTlsServer(pair, (req, res) => {
    const isReady = req.url.startsWith("/api/ready");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(isReady ? READY : STATUS_BODY));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(process.execPath, [PROBE], {
      SMOKE_URL: `https://127.0.0.1:${server.address().port}`,
      SMOKE_ATTEMPTS: "1", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1",
      NODE_TLS_REJECT_UNAUTHORIZED: "0", // a self-signed fixture; the expiry is what is under test
      ...env,
    });
  } finally {
    server.close();
  }
}

test("A CERTIFICATE ABOUT TO EXPIRE FAILS THE PROBE: nothing on the box can see this", async (t) => {
  // Caddy renews a 90-day certificate at about 30 days left, so few days left means
  // renewal has already stopped working. The box cannot notice: the watchdog asks the
  // app over loopback and Let's Encrypt has no contact address for this account.
  const r = await runTlsProbe(10);
  if (!r) return t.skip("SMOKE_TEST_ALLOW_NO_OPENSSL=1 and no openssl here");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /the TLS certificate has more than 21 whole days left/);
  assert.match(r.out, /renewal has ALREADY not worked/);
});

test("a certificate with room left passes, and says how much", async (t) => {
  const r = await runTlsProbe(60);
  if (!r) return t.skip("SMOKE_TEST_ALLOW_NO_OPENSSL=1 and no openssl here");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok: the TLS certificate has more than 21 whole days left \(5\d days/);
});

test("the floor is settable, so a shorter-lived certificate can still be watched", async (t) => {
  const r = await runTlsProbe(10, { SMOKE_TLS_MIN_DAYS: "5" });
  if (!r) return t.skip("SMOKE_TEST_ALLOW_NO_OPENSSL=1 and no openssl here");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok: the TLS certificate has more than 5 whole days left/);
});

test("an ALREADY EXPIRED certificate says so, and does not read like a dead box", async (t) => {
  // rejectUnauthorized is on by default, so an expired certificate fails the HANDSHAKE
  // and never reaches the days-left branch - which is where the runbook sentence lives.
  // Without the error code, "expired three days ago" and "nothing is listening" printed
  // the same line, at the one moment the difference matters most.
  const pair = expiredCert();
  const server = createTlsServer(pair, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.startsWith("/api/ready") ? READY : STATUS_BODY));
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  // NO NODE_TLS_REJECT_UNAUTHORIZED HERE, on purpose: production verifies, and that is
  // the whole point - verification is what turns an expired certificate into a handshake
  // failure rather than a days-left number.
  const r = await run(process.execPath, [PROBE], {
    SMOKE_URL: `https://127.0.0.1:${server.address().port}`,
    SMOKE_ATTEMPTS: "1", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1",
  });
  server.close();
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /ALREADY EXPIRED/);
  assert.match(r.out, /renewal stopped long ago/);
});

test("a handshake that fails while the faucet answers is the probe, not the certificate", async (t) => {
  // The check runs once, outside the retry loop, so one runner-side blip would red the
  // whole run on its own. The faucet checks reach the SAME https origin: if they got
  // answers, TLS demonstrably works. The explorer check downgrades for the same reason.
  //
  // Modelled honestly: the server stops ACCEPTING after it has answered both fetches, so
  // the later raw handshake is refused while the faucet checks have already passed. No
  // test-only switch in the probe; this is a real sequence a flaky runner produces.
  const pair = selfSigned(60);
  if (!pair) {
    if (process.env.SMOKE_TEST_ALLOW_NO_OPENSSL === "1") return t.skip("no openssl here");
    assert.fail("openssl produced no certificate");
  }
  let answered = 0;
  const server = createTlsServer(pair, (req, res) => {
    const isReady = req.url.startsWith("/api/ready");
    res.writeHead(200, { "content-type": "application/json" });
    answered += 1;
    // Stop accepting as the SECOND response goes out, so the raw handshake that follows
    // is refused while both fetches have already succeeded.
    res.end(JSON.stringify(isReady ? READY : STATUS_BODY), () => {
      if (answered >= 2) server.close();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const r = await run(process.execPath, [PROBE], {
    SMOKE_URL: `https://127.0.0.1:${server.address().port}`,
    SMOKE_ATTEMPTS: "1", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  });
  server.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /the faucet answered over the same origin, so this is the probe/);
});

test("A CERTIFICATE FAULT IS NEVER A BLIP, however well the fetches went", async (t) => {
  // The downgrade allowlisted everything EXCEPT CERT_HAS_EXPIRED, which swept up an
  // untrusted chain - Caddy falling back to its internal issuer after ACME gave up, which
  // the probe's own comment names as a real failure mode - and printed
  // `live-probe: healthy` on a site no browser can load.
  //
  // The fetches and the handshake are genuinely split here: the server answers both
  // fetches under a certificate the probe TRUSTS (NODE_EXTRA_CA_CERTS), then swaps to an
  // untrusted one before the raw handshake. That is not contrived - undici reuses a
  // pooled keep-alive socket and never re-handshakes, so in production fetch and
  // tls.connect really do disagree, and fetch is the one that is wrong.
  const trusted = selfSigned(60);
  const untrusted = selfSigned(60);
  if (!trusted || !untrusted) {
    if (process.env.SMOKE_TEST_ALLOW_NO_OPENSSL === "1") return t.skip("no openssl here");
    assert.fail("openssl produced no certificate");
  }
  let answered = 0;
  const server = createTlsServer(trusted, (req, res) => {
    answered += 1;
    res.end(JSON.stringify(req.url.startsWith("/api/ready") ? READY : STATUS_BODY), () => {
      if (answered >= 2) server.setSecureContext(untrusted);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const r = await run(process.execPath, [PROBE], {
    SMOKE_URL: `https://127.0.0.1:${server.address().port}`,
    SMOKE_ATTEMPTS: "1", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1",
    NODE_EXTRA_CA_CERTS: trusted.certPath,
  });
  server.close();
  assert.notEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /so this is the probe, not the certificate/);
  assert.match(r.out, /not usable \(a wrong name, or an issuer nobody trusts/);
});

test("an expired certificate reads as expired even on the lenient path", async () => {
  // With verification off the handshake succeeds and the days-left branch runs, where
  // "-4 days left" is exactly the reading the expiry message exists to stop.
  const pair = expiredCert();
  const server = createTlsServer(pair, (req, res) => {
    res.end(JSON.stringify(req.url.startsWith("/api/ready") ? READY : STATUS_BODY));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const r = await run(process.execPath, [PROBE], {
    SMOKE_URL: `https://127.0.0.1:${server.address().port}`,
    SMOKE_ATTEMPTS: "1", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  });
  server.close();
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /ALREADY EXPIRED/);
  assert.doesNotMatch(r.out, /days left/);
});

test("an https origin is required for the certificate to be watched at all", async () => {
  // Caddy 308s :80 to :443 and fetch follows redirects, so an http SMOKE_URL is a fully
  // green run with ZERO certificate coverage. The skip line is the only thing that says
  // so, which is why it is asserted rather than left to whoever reads the log.
  const r = await runProbe({});
  assert.match(r.out, /certificate: skipped, http:\/\/[^ ]+ is not https/);
});

test("an empty SMOKE_TLS_MIN_DAYS does not silently mean zero", async (t) => {
  // "" is exactly what GitHub Actions hands an unset repository variable, and Number("")
  // is 0: the check passed green with the floor turned off.
  const r = await runTlsProbe(10, { SMOKE_TLS_MIN_DAYS: "" });
  if (!r) return t.skip("SMOKE_TEST_ALLOW_NO_OPENSSL=1 and no openssl here");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /more than 21 whole days left/);
});

test("a negative SMOKE_TLS_MIN_DAYS is the empty-string hole with extra typing", async (t) => {
  // A floor below zero passes any certificate that has not already expired, which is the
  // same "turned off, and green" outcome as the empty string.
  const r = await runTlsProbe(10, { SMOKE_TLS_MIN_DAYS: "-1" });
  if (!r) return t.skip("SMOKE_TEST_ALLOW_NO_OPENSSL=1 and no openssl here");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /more than 21 whole days left/);
});

test("an IP-literal origin sends no SNI, because RFC 6066 forbids it", async (t) => {
  // Node warns DEP0123 and says it will start ignoring the value. Every test here uses
  // 127.0.0.1, so without the guard the warning is permanent noise on the gate.
  const r = await runTlsProbe(60);
  if (!r) return t.skip("SMOKE_TEST_ALLOW_NO_OPENSSL=1 and no openssl here");
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.err, /DEP0123/);
});

test("a SMOKE_URL that is not a URL says the check was skipped, rather than nothing", async () => {
  const r = await runProbe({ SMOKE_URL: "faucet.example.org" });
  assert.match(r.out, /certificate: skipped, "faucet.example.org" is not a URL/);
});

test("an http origin skips the certificate check rather than failing it", async () => {
  const r = await runProbe({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /certificate: skipped, http:\/\/127\.0\.0\.1:\d+ is not https/);
});
