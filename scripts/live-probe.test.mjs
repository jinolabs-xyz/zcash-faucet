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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const PROBE = fileURLToPath(new URL("./live-probe.mjs", import.meta.url));

/** A faucet that answers /api/status and /api/ready however the case wants. */
// The fake answers the way the real route does (R-24): the detailed box only to a
// request carrying the token in x-faucet-ops, one word to everyone else. `box` overrides
// the detailed shape; `publicBox` the one-word one.
function fakeFaucet(ready, { box, publicBox, token = "", buildCommit = "abc1234" } = {}) {
  const server = createServer((req, res) => {
    const detailed = box ?? { state: "complete", expected: 1, present: 1, notEnabled: 0, watchdogUnit: "active", alertBridge: "ok", minerBinary: "current", ageSeconds: 5 };
    const ops = token && req.headers["x-faucet-ops"] === token;
    const status = {
      network: "testnet", dripTaz: 0.1, balanceTaz: 100, empty: false, queueDepth: 0,
      challenge: "pow", node: { ready: true, syncPercent: 100, height: 10, frozen: false },
      backend: { reachable: true },
      box: ops ? { ...detailed, verdict: detailed.verdict ?? "ok" } : (publicBox ?? { state: "ok", minerUnit: null }),
      ...(ops ? { buildCommit } : {}),
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

async function runProbe(env, ready = READY, shape = {}) {
  const server = fakeFaucet(ready, shape);
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

// ── THE OPERATOR'S VIEW IS TOKEN-GATED, AND THE PUBLIC WORD STILL CARRIES THE VERDICT (R-24) ──

test("with the token, the probe judges the detailed box by its one-word verdict and NEVER prints the fault's name", async () => {
  // This repository is public and a run log is readable by anyone with a GitHub account:
  // "faucet-watchdog.service is STOPPED" printed here would be R-24's leak, moved
  // (review of #543, round 2).
  const r = await runProbe({ SMOKE_OPS_TOKEN: "t0ken-t0ken-t0ken-t0ken" }, READY, { token: "t0ken-t0ken-t0ken-t0ken", box: { state: "complete", expected: 1, present: 1, notEnabled: 0, watchdogUnit: "inactive", alertBridge: "ok", minerBinary: "current", ageSeconds: 5, verdict: "attention" } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /FAIL: the box is ok.*the box reports "attention"/);
  assert.doesNotMatch(r.out, /watchdog\.service|STOPPED|inactive|alertBridge|bridge/i, "no unit or bridge name in a public run log");
  assert.match(r.out, /ok: the operator token, when sent, is honoured/);
});

test("without the token, a box that reports attention is STILL RED: the one word is the same verdict", async () => {
  const r = await runProbe({}, READY, { token: "t0ken-t0ken-t0ken-t0ken", publicBox: { state: "attention", minerUnit: null } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /the box reports "attention"; which fault is on the box's own report/);
  assert.doesNotMatch(r.out, /STOPPED|alertBridge/, "and it names no fault");
});

test("without the token, an ok box passes: the word is affirmative, not a shrug", async () => {
  const r = await runProbe({}, READY, { token: "t0ken-t0ken-t0ken-t0ken" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok: the box is ok/);
});

test("a WRONG token is refused and the probe says so, rather than passing on the public word", async () => {
  const r = await runProbe({ SMOKE_OPS_TOKEN: "wrong-wrong-wrong-wrong" }, READY, { token: "t0ken-t0ken-t0ken-t0ken", publicBox: { state: "unknown", minerUnit: null } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /FAIL: the operator token, when sent, is honoured/);
});

test("a WRONG token over an ok box is STILL red: a configured token that does not work is a fault of its own", async () => {
  // Review of #543: the first cut folded this into the public "ok" and printed healthy,
  // so a rotated or mistyped secret would have hidden itself for as long as the box was fine.
  const r = await runProbe({ SMOKE_OPS_TOKEN: "wrong-wrong-wrong-wrong" }, READY, { token: "t0ken-t0ken-t0ken-t0ken" });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /FAIL: the operator token, when sent, is honoured/);
  assert.match(r.out, /ok: the box is ok/, "the box itself still reads ok; it is the token that failed");
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

/**
 * A TLS server that is closed when the TEST ends, however it ends.
 *
 * Five tests below used to start a server and close it on the last line of the test
 * body. An assertion failing above that line skipped the close, the listening socket
 * kept the process alive, and `node --test` never exited: measured, a single red test
 * printed its failure at 101ms and the process was still there at 90s. ci.yml has no
 * timeout on the test job, so a five-second red became GitHub's six-hour default hang
 * (#481). t.after() runs on failure too. `listening` is checked because one test closes
 * its server early from inside the handler, and closing twice is not an error worth
 * having in a cleanup hook.
 */
function serveFor(t, pair, handler) {
  const server = createTlsServer(pair, handler);
  t.after(() => { if (server.listening) server.close(); });
  return server;
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
  const server = serveFor(t, pair, (req, res) => {
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
  const server = serveFor(t, pair, (req, res) => {
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
  const server = serveFor(t, trusted, (req, res) => {
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
  assert.notEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /so this is the probe, not the certificate/);
  assert.match(r.out, /not usable \(a wrong name, or an issuer nobody trusts/);
});

test("an expired certificate reads as expired even on the lenient path", async (t) => {
  // With verification off the handshake succeeds and the days-left branch runs, where
  // "-4 days left" is exactly the reading the expiry message exists to stop.
  const pair = expiredCert();
  const server = serveFor(t, pair, (req, res) => {
    res.end(JSON.stringify(req.url.startsWith("/api/ready") ? READY : STATUS_BODY));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const r = await run(process.execPath, [PROBE], {
    SMOKE_URL: `https://127.0.0.1:${server.address().port}`,
    SMOKE_ATTEMPTS: "1", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /ALREADY EXPIRED/);
  assert.doesNotMatch(r.out, /days left/);
});

test("a handshake failure with NO working fetch is never downgraded", async () => {
  // The downgrade rests on the fetches having succeeded. Without that precondition it
  // would swallow a total outage, so the precondition is pinned rather than assumed:
  // nothing is listening here, so `faucetReachable` is false and the certificate line
  // must FAIL rather than print the blip wording.
  const r = await runProbe({ SMOKE_URL: "https://127.0.0.1:1" });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /FAIL: the TLS certificate can be read/);
  assert.doesNotMatch(r.out, /so this is the probe, not the certificate/);
});

test("the floor FAILS at exactly the threshold, which is what the runbook says", async (t) => {
  // `days > TLS_MIN_DAYS`, not `>=`. A certificate with exactly the floor's worth of days
  // left is already past the point Caddy should have renewed, and the docs, the check's
  // name and the code have to agree on which side of the line that falls.
  // `-days 10` is ten days minus the seconds since it was issued, so it floors to 9.
  const r = await runTlsProbe(10, { SMOKE_TLS_MIN_DAYS: "9" });
  if (!r) return t.skip("SMOKE_TEST_ALLOW_NO_OPENSSL=1 and no openssl here");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /FAIL: the TLS certificate has more than 9 whole days left/);
  // And one day above it passes, so the boundary is pinned from both sides.
  const ok8 = await runTlsProbe(10, { SMOKE_TLS_MIN_DAYS: "8" });
  assert.equal(ok8.code, 0, ok8.out);
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

test("SMOKE_ATTEMPTS=0 still probes once: zero attempts must not read as healthy", async () => {
  // The floor is `Math.max(1, numEnv(..., 1))`, and nothing pinned it. Review removed
  // both halves and the probe, pointed at a dead origin with SMOKE_ATTEMPTS=0, printed
  // "live-probe: healthy" and exited 0 - a probe that passes having probed nothing,
  // which is the one thing this file exists to refuse.
  const r = await run(process.execPath, [PROBE], {
    SMOKE_URL: "http://127.0.0.1:1",
    SMOKE_ATTEMPTS: "0", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1",
  });
  assert.notEqual(r.code, 0, "a dead origin must fail whatever SMOKE_ATTEMPTS says");
  assert.doesNotMatch(r.out, /live-probe: healthy/);
  // The proof that an attempt happened is the failure line from the status fetch and a
  // non-zero attempt count in the verdict. Not "attempt 1/": that line is printed only
  // when there is a SECOND attempt to wait for, so it pinned "the default of 3 applied"
  // and would fail a probe that clamped 0 to exactly one attempt - which is also fine.
  assert.match(r.out, /FAIL: GET \/api\/status/, "the status fetch was attempted and failed");
  assert.match(r.out, /after [1-9]\d* attempt\(s\)/, "the verdict counts at least one attempt");
});

test("SMOKE_TIMEOUT_MS=0 falls back to the default rather than meaning no timeout", async (t) => {
  // A handshake timeout of 0 is no timeout: a black-holed 443 - accepts the TCP
  // connection and never speaks - would hold the probe for the OS's own connect timeout,
  // minutes, on every scheduled run. The floor is 1 and nothing pinned it. This server
  // accepts and says nothing. With the fallback in place the status fetch dies at ~10s
  // (undici's own connect timeout lands before the 15s signal) and the TLS handshake at
  // 15s, ~25s measured; run()'s 60s bomb is the ceiling. The mutant fails the fetch at
  // once and then sits in tls.connect with timeout 0 for minutes, so 50s separates them
  // by more than a factor of two either way.
  const net = await import("node:net");
  const hole = net.createServer((sock) => { /* accept, never write, never close */ sock.on("error", () => {}); });
  await new Promise((r) => hole.listen(0, "127.0.0.1", r));
  t.after(() => hole.close());
  const started = Date.now();
  const r = await run(process.execPath, [PROBE], {
    SMOKE_URL: `https://127.0.0.1:${hole.address().port}`,
    SMOKE_TIMEOUT_MS: "0", SMOKE_ATTEMPTS: "1", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1",
  });
  const elapsed = Date.now() - started;
  assert.notEqual(r.code, 0, "a black hole must fail");
  assert.ok(elapsed < 50_000, `took ${elapsed}ms: with SMOKE_TIMEOUT_MS=0 the fallback timeout did not apply`);
});

test("SMOKE_RETRY_DELAY_MS=0 means retry immediately, and is not overridden", async () => {
  // A helper that quietly REPLACES a value someone set is the same defect as one that
  // quietly accepts a bad one. Guarding the numeric env vars with a "must be positive"
  // floor rejected 0 - a legitimate "do not wait" - and every retry in this file became a
  // 30-second sleep, which hung the whole run. The bound below is deliberately loose:
  // two attempts with no delay take well under a second, and the mutation costs 30s, so
  // this distinguishes them by a factor of thirty rather than by milliseconds.
  const dead = "https://127.0.0.1:1";   // nothing listens on port 1
  const started = Date.now();
  const r = await run(process.execPath, [PROBE], {
    SMOKE_URL: dead,
    SMOKE_ATTEMPTS: "2", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1",
  });
  const elapsed = Date.now() - started;
  assert.notEqual(r.code, 0, "a dead origin must fail");
  assert.ok(elapsed < 20_000, `two attempts with no delay took ${elapsed}ms; the delay was not honoured`);
});

test("a SMOKE_URL with surrounding whitespace works, rather than paging about a missing field", async (t) => {
  // The workflow accepts it because `new URL()` does. Without a trim HERE, a TRAILING
  // space lands inside the request path: measured, `" https://host/ "` fetched
  // `https://host/%20/api/status` and the run paged with "node.canBuildTx is undefined;
  // the field this probe pages on is gone" - an operator hunting an API regression for a
  // stray space. The workflow's own check for this runs against a stubbed node, so it
  // cannot see this half; this is where it is seen.
  const pair = selfSigned(60);
  if (!pair) {
    if (process.env.SMOKE_TEST_ALLOW_NO_OPENSSL === "1") return t.skip("no openssl here");
    assert.fail("openssl produced no certificate");
  }
  const server = serveFor(t, pair, (req, res) => {
    res.end(JSON.stringify(req.url.startsWith("/api/ready") ? READY : STATUS_BODY));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `https://127.0.0.1:${server.address().port}`;
  for (const raw of [` ${base} `, ` ${base}/ `, `\t${base}\n`]) {
    const r = await run(process.execPath, [PROBE], {
      SMOKE_URL: raw,
      SMOKE_ATTEMPTS: "1", SMOKE_RETRY_DELAY_MS: "0", SMOKE_SKIP_EXPLORER: "1",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    });
    assert.equal(r.code, 0, `${JSON.stringify(raw)}: ${r.out}`);
    assert.match(r.out, /live-probe: healthy/);
    assert.doesNotMatch(r.out, /the field this probe pages on is gone/);
  }
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

// ── THE BOX ANSWERS IN GITHUB: the drift verdict and the box's commit (#721's follow-up) ──

const TOKEN = "t0ken-t0ken-t0ken-t0ken";

// A repo of the row's own, not the runner's checkout: CI clones at depth 1, where
// `git rev-parse HEAD~1` prints the literal "HEAD~1" to stdout with the error on stderr, and
// the first cut of these rows handed the probe that string (red in CI, green on every laptop).
// Two commits, `a` then `b`; `whenB` dates the head so "fresh" and "stale" are chosen, not
// observed. Every sha is asserted 40-hex, so a fixture that stops producing one says so.
function mainRepo(whenB) {
  const dir = mkdtempSync(join(tmpdir(), "probe-main-"));
  const at = (iso) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  const g = (env, ...a) => {
    const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(r.status, 0, `git ${a.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  g({}, "init", "-q");
  g(at("2020-01-01T00:00:00Z"), "commit", "-q", "--allow-empty", "-m", "a");
  const a = g({}, "rev-parse", "HEAD");
  g(at(whenB), "commit", "-q", "--allow-empty", "-m", "b");
  const b = g({}, "rev-parse", "HEAD");
  for (const sha of [a, b]) assert.match(sha, /^[0-9a-f]{40}$/, "the fixture must hand the probe a real sha");
  return { a, b, env: { SMOKE_MAIN_REF: "HEAD", GIT_DIR: join(dir, ".git") }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("drift: a server that does not send the word is cannot-verify, not a pass on silence and not a fault", async () => {
  const r = await runProbe({}, READY, { token: TOKEN });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /the box's drift audit reads clean.*server does not send `drift` yet, cannot verify/);
});

test("drift: the public word \"drift\" is RED, says the box and the repo disagree, and names no finding", async () => {
  const r = await runProbe({}, READY, { token: TOKEN, publicBox: { state: "ok", minerUnit: null, drift: "drift" } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /FAIL: the box's drift audit reads clean.*the box and the repo DISAGREE/);
  assert.match(r.out, /journalctl -u faucet-drift-report/, "the operator is sent to the box's own journal for the names");
});

test("drift: \"stale\" is red with its own sentence - an audit that stopped arriving is not yesterday's clean", async () => {
  const r = await runProbe({}, READY, { token: TOKEN, publicBox: { state: "ok", minerUnit: null, drift: "stale" } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /older than 90 minutes.*stopped arriving/);
});

test("drift: \"unknown\" and \"incomplete\" are red too, each with a different sentence", async () => {
  const u = await runProbe({}, READY, { token: TOKEN, publicBox: { state: "ok", minerUnit: null, drift: "unknown" } });
  assert.notEqual(u.code, 0); assert.match(u.out, /has not published a drift audit result/);
  const i = await runProbe({}, READY, { token: TOKEN, publicBox: { state: "ok", minerUnit: null, drift: "incomplete" } });
  assert.notEqual(i.code, 0); assert.match(i.out, /could not run every check/);
});

test("drift: \"clean\" passes, and with the token the counts and age ride the line - numbers, never names", async () => {
  const pub = await runProbe({}, READY, { token: TOKEN, publicBox: { state: "ok", minerUnit: null, drift: "clean" } });
  assert.equal(pub.code, 0, pub.out);
  const ops = await runProbe({ SMOKE_OPS_TOKEN: TOKEN }, READY, { token: TOKEN, box: { state: "complete", expected: 1, present: 1, notEnabled: 0, watchdogUnit: "active", alertBridge: "ok", minerBinary: "current", ageSeconds: 5, drift: { state: "drift", findings: 3, unverified: 1, ageSeconds: 120, repoSha: "0123456789abcdef0123456789abcdef01234567" } } });
  assert.notEqual(ops.code, 0);
  assert.match(ops.out, /FAIL: the box's drift audit reads clean.*DISAGREE.*\(3 finding\(s\), 1 unverified, 120s old\)/);
});

test("the box runs main: main's own head passes; a stranger commit is red; no ref means not compared, said so", async () => {
  const repo = mainRepo(new Date().toISOString());
  try {
    const onMain = await runProbe({ SMOKE_OPS_TOKEN: TOKEN, ...repo.env }, READY, { token: TOKEN, buildCommit: repo.b.slice(0, 7) });
    assert.equal(onMain.code, 0, onMain.out);
    assert.match(onMain.out, /ok: the box runs main.*which is HEAD/);
    const stranger = await runProbe({ SMOKE_OPS_TOKEN: TOKEN, ...repo.env }, READY, { token: TOKEN, buildCommit: "deadbee" });
    assert.notEqual(stranger.code, 0);
    assert.match(stranger.out, /FAIL: the box runs main.*deadbee, which this checkout does not know/);
  } finally { repo.done(); }
  const noRef = await runProbe({ SMOKE_OPS_TOKEN: TOKEN }, READY, { token: TOKEN, buildCommit: "deadbee" });
  assert.equal(noRef.code, 0, noRef.out);
  assert.match(noRef.out, /SMOKE_MAIN_REF is not set, so the box's commit was not compared/);
});

test("the box runs main: a FRESH ancestor is allowed inside the deploy window, and says so", async () => {
  const repo = mainRepo(new Date().toISOString());
  try {
    const r = await runProbe({ SMOKE_OPS_TOKEN: TOKEN, ...repo.env }, READY, { token: TOKEN, buildCommit: repo.a.slice(0, 7) });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ok: the box runs main.*moved to .* \d+ min ago and the box runs its ancestor .*; auto-deploy has 20 minutes/);
  } finally { repo.done(); }
});

test("the box runs main: a STALE ancestor is red - main moved and the deploy did not land", async () => {
  const repo = mainRepo("2020-01-02T00:00:00Z");
  try {
    const r = await runProbe({ SMOKE_OPS_TOKEN: TOKEN, ...repo.env }, READY, { token: TOKEN, buildCommit: repo.a.slice(0, 7) });
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /FAIL: the box runs main.*has been at .* for \d+ minutes and the box still runs .*: the deploy did not land/);
  } finally { repo.done(); }
});

test("the box runs main: a dirty-checkout suffix is red, and an unstamped image is red, each by name", async () => {
  const repo = mainRepo(new Date().toISOString());
  try {
    const dirty = await runProbe({ SMOKE_OPS_TOKEN: TOKEN, ...repo.env }, READY, { token: TOKEN, buildCommit: repo.b.slice(0, 7) + "-modified" });
    assert.notEqual(dirty.code, 0);
    assert.match(dirty.out, /FAIL: the box runs main.*uncommitted changes on the box's checkout/);
    const unknown = await runProbe({ SMOKE_OPS_TOKEN: TOKEN, ...repo.env }, READY, { token: TOKEN, buildCommit: "unknown" });
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /FAIL: the box runs main.*did not say which commit it runs/);
  } finally { repo.done(); }
});
