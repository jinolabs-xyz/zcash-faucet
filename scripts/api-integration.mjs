// Route-level integration tests: boot the BUILT app (never dev, it does not
// bundle) in two configurations and drive every API route over HTTP. This is
// the layer that catches cross-route regressions unit tests cannot see.
//
//   npm run build && npm run test:api
//
// Server A (funded, pow gate): the happy paths plus every faucet rejection.
// Server B (empty wallet):     the honest degraded states, ready 503 included.
//
// Fixtures are encoded at runtime with the same coders address.ts decodes
// with (@scure/base is an app dependency), so they stay checksum-valid by
// construction and cannot drift from the validator.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { bech32m } from "@scure/base";

const PORT_A = 3210;
const PORT_B = 3211;
const PORT_C = 3212;
const PORT_D = 3213;
const PORT_E = 3214;
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_B = `http://localhost:${PORT_B}`;
const BASE_C = `http://localhost:${PORT_C}`;
const BASE_D = `http://localhost:${PORT_D}`;
const BASE_E = `http://localhost:${PORT_E}`;

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "ok" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
};

/* ── fixtures ──────────────────────────────────────────────────────────── */
const seq = (n, fill) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + fill) & 0xff);
const ua = (fill) => bech32m.encode("utest", bech32m.toWords(seq(96, fill)), 1023);
const UNIFIED_A = ua(3);
const UNIFIED_B = ua(41);
// Donate-page fixtures at REAL length. A short stand-in would pass a
// truncation bug straight through, and a truncated address on a donate page
// loses donations silently with nothing in any log.
const DONATION_UA = ua(7);
const MINING_TADDR = "tmUiVxo1bbZLP5z6KYfM4dh3PcX5wkd7on8"; // 35 chars, the real shape

// One flipped char in the data part breaks the bech32m checksum.
const UNIFIED_BAD = UNIFIED_A.slice(0, -3) + (UNIFIED_A.at(-3) === "q" ? "p" : "q") + UNIFIED_A.slice(-2);

/* ── tiny harness (same pattern as e2e-smoke) ──────────────────────────── */
function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    for (let m = 0x80; m > 0; m >>= 1) {
      if (byte & m) return bits;
      bits++;
    }
    return bits;
  }
  return bits;
}
function solve({ seed, difficulty }) {
  for (let nonce = 0; ; nonce++) {
    const digest = createHash("sha256").update(`${seed}:${nonce}`).digest();
    if (leadingZeroBits(digest) >= difficulty) return String(nonce);
  }
}
async function req(base, path, init) {
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const get = (base, path) => req(base, path);
const post = (base, path, body) =>
  req(base, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const claim = (base, address, pow) => post(base, "/api/faucet", { address, ...(pow ? { pow } : {}) });

async function solvedChallenge(base) {
  const { status, body } = await get(base, "/api/pow/challenge");
  if (status !== 200 || !body.seed) throw new Error(`challenge fetch failed: ${status}`);
  return { seed: body.seed, difficulty: body.difficulty, exp: body.exp, sig: body.sig, nonce: solve(body) };
}

/* ── server lifecycle ──────────────────────────────────────────────────── */
function boot(port, env) {
  const child = spawn("npm", ["run", "start"], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: "ignore",
    detached: true, // own process group, so kill(-pid) reaps next too
  });
  return child;
}
/**
 * Poll the tip-oracle fixture until it answers, so no app can out-race it.
 *
 * @param expectTestnetRow when true (the default) we additionally require a usable
 *   testnet row, because a 200 with an unusable body would let the oracle's
 *   fallback fire anyway — the failure this wait exists to prevent.
 *
 *   An EMPTY=true fixture deliberately serves no testnet row, to make the oracle's
 *   cannot-verify path reachable. Waiting for a row there would hang and then throw,
 *   so a caller exercising that mode must pass false. Before this parameter existed,
 *   fake-hosh advertised an EMPTY mode that could only produce a dead suite (SDE-App).
 */
async function waitHosh(expectTestnetRow = true, ms = 15_000, port = HOSH_PORT) {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const rows = await res.json();
        const servers = Array.isArray(rows?.servers) ? rows.servers : [];
        if (!expectTestnetRow) return; // responding at all is the whole requirement
        if (servers.some((r) => r.chain === "test" && r.online && r.height > 0)) return;
      }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(
        expectTestnetRow
          ? `tip-oracle fixture at ${url} never served a usable testnet height`
          : `tip-oracle fixture at ${url} never responded`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitReady(base, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server at ${base} did not come up`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
function stop(child) {
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
}

// Two doubles, two apps. The app runs its production ZalletSender against a
// fake wallet, so the path under test is the shipped one.
const WALLET_A = 28321;
const WALLET_B = 28322;
const wallet = (port, balanceTaz) =>
  spawn("node", ["scripts/fake-zallet.mjs"], {
    env: { ...process.env, PORT: String(port), BALANCE_TAZ: String(balanceTaz) },
    stdio: "ignore",
    detached: true,
  });
// C's wallet accepts the send and then never finishes the operation, which is
// the shape of the hang the queue deadline exists for (#88).
const WALLET_C = 28323;
const walletA = wallet(WALLET_A, 10);
const walletB = wallet(WALLET_B, 0);
const walletC = spawn("node", ["scripts/fake-zallet.mjs"], {
  env: { ...process.env, PORT: String(WALLET_C), BALANCE_TAZ: "10", SEND_HANGS: "true" },
  stdio: "ignore",
  detached: true,
});

// D's wallet is healthy and well funded. The ONLY thing wrong with D is that the
// network has moved 40 blocks past our node, which is the tx 29 lag exactly.
const WALLET_D = 28325;
const walletD = wallet(WALLET_D, 10);
// E's wallet is healthy too. E's oracle is the one that has nothing to say.
const WALLET_E = 28327;
const walletE = wallet(WALLET_E, 10);

// A hosh-shaped tip oracle. Without it the readiness assertions depend on the
// public internet AND on a race: the wallet double reports tip 3,650,000 while
// real testnet is past 4,220,000, so the moment the oracle gets a real answer our
// node reads as ~570,000 blocks behind and A returns 503 where we expect 200.
// Whether that lands before the assertion decided whether CI was green (#171).
const HOSH_PORT = 28324;
const fakeHosh = spawn("node", ["scripts/fake-hosh.mjs"], {
  env: { ...process.env, PORT: String(HOSH_PORT) },
  stdio: "ignore",
  detached: true,
});

// A SECOND oracle, reporting the network 40 blocks ahead of the wallet double's
// 3,650,000. 40 is picked to sit in the gap that #187 is about: past the shield
// gate's 5-block budget, so a transaction built now would carry a dead expiry, but
// nowhere near FREEZE_BLOCKS at 200, so `frozen` stays false and readiness keeps
// answering 200. A lag of 1000 would also refuse the drip and would prove much
// less, because `frozen` would be doing the work.
const HOSH_STALE_PORT = 28326;
const STALE_LAG = 40;
const fakeHoshStale = spawn("node", ["scripts/fake-hosh.mjs"], {
  env: { ...process.env, PORT: String(HOSH_STALE_PORT), HEIGHT: String(3_650_000 + STALE_LAG) },
  stdio: "ignore",
  detached: true,
});

// A THIRD oracle that serves no usable testnet row, so the tip is genuinely
// unknown rather than merely stale. This is the fail-closed case: "cannot verify"
// must refuse a payout exactly as "too far behind" does, because a gate that only
// catches the state it can measure is the one that let #172 happen. EMPTY=true is
// the mode fake-hosh advertised and could not deliver until waitHosh gained its
// expectTestnetRow parameter.
const HOSH_EMPTY_PORT = 28328;
const fakeHoshEmpty = spawn("node", ["scripts/fake-hosh.mjs"], {
  env: { ...process.env, PORT: String(HOSH_EMPTY_PORT), EMPTY: "true" },
  stdio: "ignore",
  detached: true,
});

// Every app gets the same deterministic chain view.
//
// Only HOSH_URL is overridden. externalTip does degrade to a direct lightwalletd
// call when hosh yields nothing, which is a second route to the real network — but
// the fixture always answers, so that route is never taken. Pinning
// LIGHTWALLETD_ENDPOINT at a closed port to block it is NOT safe: the same
// variable is also the app's read-side backend, so breaking it makes readiness
// report "backend unreachable" and fails a different assertion. Verified by doing
// exactly that and watching it fail.
const chainView = {
  HOSH_URL: `http://127.0.0.1:${HOSH_PORT}/`,
};

const zallet = (rpcPort) => ({
  FAUCET_SENDER: "zallet",
  ZALLET_RPC_URL: `http://127.0.0.1:${rpcPort}/`,
  ZALLET_ACCOUNT: "test-account",
  ZALLET_ADDRESS: "utest1testfaucet",
  ZALLET_MIN_CONF: "0",
  ZALLET_POLL_MS: "250",
});

const serverA = boot(PORT_A, {
  ...zallet(WALLET_A),
  ...chainView,
  FAUCET_CHALLENGE: "pow",
  RATE_LIMIT_SALT: "integration-test-salt",
  FAUCET_POW_BITS: "8",
  FAUCET_POW_ESCALATE_BITS: "0",
  FAUCET_DONATION_ADDRESS: DONATION_UA,
  FAUCET_MINING_ADDRESS: MINING_TADDR,
});
const serverB = boot(PORT_B, {
  ...zallet(WALLET_B),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  // Pinned low so the /api/tx limiter is reachable in a test. The shipped
  // default is 60/min, which exists to NOT limit our own receipt poll.
  TX_LOOKUP_RATE_WINDOW_SECONDS: "60",
  TX_LOOKUP_RATE_MAX: "3",
  // The limiter keys on the client IP, and clientIp() only trusts XFF when we
  // say a proxy is in front. deploy/z3 runs Caddy and sets this to 1, so the
  // test mirrors production rather than the default no-proxy case.
  TRUSTED_PROXY_COUNT: "1",
});
// The deadline is normally derived at ~309s, far above any legitimate send. Pin
// it low here so the hang path is reachable in a test rather than never covered.
const serverC = boot(PORT_C, {
  ...zallet(WALLET_C),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  SEND_TASK_DEADLINE_MS: "2500",
  ZALLET_OP_TIMEOUT_MS: "600000", // the sender must NOT be what gives up first
});

// D: a healthy wallet behind a stale chain view. Challenge off so a claim is one
// POST, which keeps the cooldown assertion below about the gate and nothing else.
const serverD = boot(PORT_D, {
  ...zallet(WALLET_D),
  HOSH_URL: `http://127.0.0.1:${HOSH_STALE_PORT}/`,
  FAUCET_CHALLENGE: "none",
});

// E: a healthy wallet whose chain view cannot be established at all. The
// lightwalletd fallback is pinned at a closed port so the oracle has NO second
// route to a real tip, which is the only way "unknown" stays unknown.
const serverE = boot(PORT_E, {
  ...zallet(WALLET_E),
  HOSH_URL: `http://127.0.0.1:${HOSH_EMPTY_PORT}/`,
  LIGHTWALLETD_ENDPOINT: "https://127.0.0.1:28399",
  FAUCET_CHALLENGE: "none",
});

try {
  // Wait for the oracle double BEFORE the apps are usable. If an app's first
  // background tip refresh runs while the fixture is still binding, hosh yields
  // nothing, externalTip degrades to a direct lightwalletd call, and the app
  // caches the REAL network tip — 570,000 blocks above the wallet double's — so it
  // reads as frozen for the rest of the run. That is the same race that made this
  // suite pass locally and fail in CI; overriding HOSH_URL is only half the fix if
  // nothing waits for the override to be listening.
  await waitHosh();
  await waitHosh(true, 15_000, HOSH_STALE_PORT);
  // false: this fixture serves no testnet row BY DESIGN, so requiring one would
  // hang and then throw. Responding at all is the whole requirement.
  await waitHosh(false, 15_000, HOSH_EMPTY_PORT);
  await Promise.all([waitReady(BASE_A), waitReady(BASE_B), waitReady(BASE_C), waitReady(BASE_D), waitReady(BASE_E)]);

  /* ── A: /api/status shape ────────────────────────────────────────────── */
  const status = await get(BASE_A, "/api/status");
  ok("A GET /api/status is 200", status.status === 200);
  const s = status.body;
  ok("A status: mode is zallet+pow", s.sender === "zallet" && s.challenge === "pow", JSON.stringify({ sender: s.sender, challenge: s.challenge }));
  ok("A status: core shape", typeof s.dripTaz === "number" && typeof s.cooldownSeconds === "number" && typeof s.balanceTaz === "number" && s.empty === false && typeof s.queueDepth === "number");
  ok("A status: backend + miner blocks", typeof s.backend?.reachable === "boolean" && typeof s.miner?.active === "boolean");
  ok("A status: reserve block shape", typeof s.reserve?.targetTaz === "number" && typeof s.reserve?.lowTaz === "number" && typeof s.reserve?.refilling === "boolean" && "spendableTaz" in (s.reserve ?? {}));

  /* ── A: /api/ready 200 ───────────────────────────────────────────────── */
  const readyA = await get(BASE_A, "/api/ready");
  ok("A GET /api/ready is 200 with reason null", readyA.status === 200 && readyA.body.ready === true && readyA.body.reason === null, JSON.stringify(readyA.body.reason ?? null));

  /* ── A: /api/pow/challenge shape ─────────────────────────────────────── */
  const ch = await get(BASE_A, "/api/pow/challenge");
  ok("A GET /api/pow/challenge is 200 with full shape", ch.status === 200 && !!(ch.body.seed && ch.body.difficulty && ch.body.exp && ch.body.sig));
  ok("A challenge expiry is in the future", ch.body.exp > Math.floor(Date.now() / 1000));

  /* ── A: /api/account generates a claimable address ───────────────────── */
  const acct = await post(BASE_A, "/api/account", { type: "transparent" });
  ok("A POST /api/account (transparent) is 200", acct.status === 200 && acct.body.ok === true);
  const tmAddr = acct.body.account?.address ?? "";
  ok("A generated address is a tm address", tmAddr.startsWith("tm"), tmAddr);

  // Shape pin (#31): the address lives at account.address, NOT at the top
  // level. The page read d.address, got undefined, and silently substituted a
  // synthesized address that fails checksum validation. Assert both halves so
  // the contract cannot drift back without a red test.
  const shielded = await post(BASE_A, "/api/account", { type: "shielded" });
  ok("A POST /api/account (shielded) is 200", shielded.status === 200 && shielded.body.ok === true);
  ok("A address is nested under account, not top level", typeof shielded.body.account?.address === "string" && shielded.body.address === undefined, `top-level address: ${JSON.stringify(shielded.body.address)}`);
  const uaAddr = shielded.body.account?.address ?? "";
  ok("A generated UA is a real utest1 address", uaAddr.startsWith("utest1") && uaAddr.length > 100, `len ${uaAddr.length}`);
  ok("A generated account carries its spending key and shielded flag", typeof shielded.body.account?.secret === "string" && shielded.body.account?.shielded === true);

  // The whole point: a generated address must survive the validator. This is
  // the Generate-then-Request flow that 400'd for every visitor.
  const genClaim = await claim(BASE_A, uaAddr, await solvedChallenge(BASE_A));
  ok("A generated UA is accepted by the claim endpoint", genClaim.status === 200 && genClaim.body.ok === true, `status ${genClaim.status} ${JSON.stringify(genClaim.body.error ?? "")}`);

  /* ── donate page wiring (#55) ────────────────────────────────────────── */
  // The page renders entirely from /api/status, so pinning these fields is
  // what stops the donate page silently going blank on a status change.
  ok("A status carries the donation address byte for byte", s.donationAddress === DONATION_UA, `len ${s.donationAddress?.length}`);
  ok("A status carries the mining address byte for byte", s.miningAddress === MINING_TADDR, `len ${s.miningAddress?.length}`);

  const donatePage = await fetch(BASE_A + "/donate");
  const donateHtml = await donatePage.text();
  ok("A GET /donate is 200", donatePage.status === 200, `status ${donatePage.status}`);
  ok("A /donate is the donate page, not a 404 shell", /Keep the tank full/.test(donateHtml));
  ok("A /donate says plainly that mining income is zero", /rounds to zero|orphaned/i.test(donateHtml));

  // The assertion that actually protects donations: the address a human SEES
  // must be the env value character for character.
  //
  // Checking the raw HTML is not enough and I proved it: with the visible span
  // deliberately truncated, `html.includes(address)` still passed, because
  // React serializes the untruncated value into the client component's props.
  // So strip everything a reader cannot see first, then assert.
  const visible = donateHtml.replace(/<script[\s\S]*?<\/script>/g, "");
  ok(`A /donate SHOWS the ${DONATION_UA.length}-char donation address exactly`, visible.includes(DONATION_UA));
  ok(`A /donate SHOWS the ${MINING_TADDR.length}-char mining address exactly`, visible.includes(MINING_TADDR));
  ok("A /donate shows no truncated form of either address", !visible.includes("\u2026"));
  ok("A main page links to /donate", /href="\/donate"/.test(await (await fetch(BASE_A + "/")).text()));

  /* ── A: faucet happy path, then every rejection ──────────────────────── */
  const sent = await claim(BASE_A, tmAddr, await solvedChallenge(BASE_A));
  ok("A claim with pow to generated address is 200 + txid", sent.status === 200 && sent.body.ok === true && typeof sent.body.txid === "string" && sent.body.txid.length >= 32, `status ${sent.status} ${JSON.stringify(sent.body.error ?? "")}`);
  ok("A claim reports transparent recipient", sent.body.to?.kind === "transparent");

  const repeat = await claim(BASE_A, tmAddr, await solvedChallenge(BASE_A));
  ok("A immediate repeat is 429 with retryAfterSeconds", repeat.status === 429 && typeof repeat.body.retryAfterSeconds === "number", `status ${repeat.status}`);

  const bad = await claim(BASE_A, UNIFIED_BAD, await solvedChallenge(BASE_A));
  ok("A checksum-broken address is 400", bad.status === 400, `status ${bad.status}`);
  ok("A 400 names the checksum", /checksum/i.test(bad.body.error ?? ""), bad.body.error);

  const noPow = await claim(BASE_A, UNIFIED_A, null);
  ok("A claim without pow is 403", noPow.status === 403, `status ${noPow.status}`);

  const forged = await solvedChallenge(BASE_A);
  forged.sig = (forged.sig[0] === "0" ? "1" : "0") + forged.sig.slice(1);
  const forgedRes = await claim(BASE_A, UNIFIED_A, forged);
  ok("A claim with forged pow sig is 403", forgedRes.status === 403, `status ${forgedRes.status}`);

  /* ── A: /api/balance ─────────────────────────────────────────────────── */
  const balShielded = await get(BASE_A, "/api/balance?address=" + encodeURIComponent(UNIFIED_B));
  ok("A balance for shielded address: 200, private, not queryable", balShielded.status === 200 && balShielded.body.shielded === true && balShielded.body.queryable === false);
  const balBad = await get(BASE_A, "/api/balance?address=" + encodeURIComponent(UNIFIED_BAD));
  ok("A balance for broken address is 400", balBad.status === 400, `status ${balBad.status}`);
  // Transparent lookups hit the public lightwalletd, deliberately not asserted
  // here: CI must not depend on an external chain endpoint.

  /* ── B: honest degraded states on an empty wallet ────────────────────── */
  const statusB = await get(BASE_B, "/api/status");
  ok("B GET /api/status reports empty", statusB.status === 200 && statusB.body.empty === true && statusB.body.balanceTaz === 0);

  const readyB = await get(BASE_B, "/api/ready");
  ok("B GET /api/ready is 503 with a reason", readyB.status === 503 && readyB.body.ready === false && typeof readyB.body.reason === "string", JSON.stringify(readyB.body.reason ?? null));

  // Unset donation address: the page must still render and say so, rather
  // than showing an empty box or 500ing.
  const statusBBody = statusB.body;
  ok("B status reports no donation address", !statusBBody.donationAddress, JSON.stringify(statusBBody.donationAddress));
  const donateB = await fetch(BASE_B + "/donate");
  const donateBHtml = await donateB.text();
  ok("B GET /donate still renders without a configured address", donateB.status === 200, `status ${donateB.status}`);
  ok("B /donate says there is nothing to send to", /No address configured|not published a donation address/i.test(donateBHtml));

  /* ── B: /api/tx per-IP limiter (#90) ─────────────────────────────────── */
  // TX_LOOKUP_RATE_MAX is 3 on this app. A real txid is not needed: the limiter
  // runs before the lookup, which is the ordering we want (a limited caller
  // must not cost us a wallet RPC).
  const TXID = "a".repeat(64);
  const lookupAs = async (ip) => {
    const res = await fetch(`${BASE_B}/api/tx?txid=${TXID}`, { headers: { "x-forwarded-for": ip } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const lookups = [];
  for (let i = 0; i < 4; i++) lookups.push(await lookupAs("203.0.113.7"));
  ok("B the first 3 lookups inside the window are served", lookups.slice(0, 3).every((r) => r.status === 200), lookups.map((r) => r.status).join(","));
  ok("B the 4th lookup is 429", lookups[3].status === 429, `status ${lookups[3].status}`);
  ok("B the 429 carries retryAfterSeconds so a client knows when to come back", typeof lookups[3].body.retryAfterSeconds === "number" && lookups[3].body.retryAfterSeconds > 0, JSON.stringify(lookups[3].body.retryAfterSeconds));

  const otherClient = await lookupAs("203.0.113.8");
  ok("B a different client is unaffected by the limited one", otherClient.status === 200, `status ${otherClient.status}`);

  const emptyClaim = await claim(BASE_B, UNIFIED_A, null);
  ok("B claim on empty wallet is 503 with the empty message", emptyClaim.status === 503 && /empty/i.test(emptyClaim.body.error ?? ""), `status ${emptyClaim.status}`);

  /* ── C: a send that hangs forever (#88) ──────────────────────────────── */
  // The wallet took the send and will never resolve the operation. The queue
  // deadline must answer the caller, and it must answer "unknown", not "failed".
  // A FRESH address per run, the same reason server A generates one. The
  // unknown-outcome path this exercises records the claim as sent and holds the
  // FULL cooldown by design (#88), so a fixed address makes this test pass
  // exactly once per day and then fail with a 429 that looks like a real bug.
  // The ledger is $cwd/data/faucet.db with no override, shared by all three apps
  // and surviving between runs.
  const genC = await post(BASE_C, "/api/account", { type: "shielded" });
  const addrC = genC.body?.account?.address;
  ok("C generated a fresh address to claim with", typeof addrC === "string" && addrC.startsWith("utest1"), String(addrC).slice(0, 12));

  const hung = await claim(BASE_C, addrC, null);
  ok("C a hung send is 504, not a 500 or a hang", hung.status === 504, `status ${hung.status}`);
  ok(
    "C the 504 tells the user NOT to retry, because coins may be moving",
    /do not retry/i.test(hung.body.error ?? ""),
    JSON.stringify(hung.body.error ?? "").slice(0, 120),
  );

  // The money-safety property. A deadline is not a failure, so the claim must
  // still be held. If the deadline released it, this retry would be allowed and
  // one entitlement could be paid twice.
  const retryAfterHang = await claim(BASE_C, addrC, null);
  ok(
    "C the claim is HELD after a deadline, so the same address cannot be paid twice",
    retryAfterHang.status === 429,
    `status ${retryAfterHang.status}, expected 429`,
  );

  // And the wallet is still counted as busy, since the send really is still in
  // flight inside the wallet.
  const statusC = await get(BASE_C, "/api/status");
  ok("C the stuck send still counts against queue depth", statusC.body.queueDepth >= 1, `depth ${statusC.body.queueDepth}`);

  /* ── D: a stale chain view must not pay out (#187) ────────────────────── */

  // First, that readiness sees NOTHING wrong. This is the whole thesis: the lag
  // that kills a transaction is invisible to the check we already had, so if these
  // two assertions ever start failing, the test has stopped covering the gap it
  // was written for and someone has widened FREEZE_BLOCKS or narrowed the lag.
  // /api/status uses the NON-BLOCKING oracle read on purpose, so the first read
  // after the cache ages past MAX_AGE_MS returns null and only then kicks a refresh.
  // This suite runs long enough for that to happen, so poll until the app has an
  // answer instead of asserting against a cache that is merely cold. The drip path
  // does not need this (it asks, bounded, before deciding) but a status reader does.
  let statusD = await get(BASE_D, "/api/status");
  for (let i = 0; i < 40 && statusD.body.node?.externalHeight == null; i++) {
    await new Promise((r) => setTimeout(r, 250));
    statusD = await get(BASE_D, "/api/status");
  }
  ok(
    "D the oracle fixture actually reached the app, so the assertions below mean something",
    statusD.body.node?.externalHeight === 3_650_000 + STALE_LAG,
    `externalHeight ${JSON.stringify(statusD.body.node?.externalHeight)}`,
  );
  ok(
    `D readiness is untroubled by a ${STALE_LAG}-block lag, which is the gap #187 is about`,
    statusD.body.node?.ready === true && statusD.body.node?.frozen === false,
    JSON.stringify({ ready: statusD.body.node?.ready, frozen: statusD.body.node?.frozen }),
  );
  const readyD = await get(BASE_D, "/api/ready");
  ok("D /api/ready still answers 200, so nothing upstream would hold traffic back", readyD.status === 200, `status ${readyD.status}`);

  // The gate itself, and the boolean the browser reads.
  ok(
    "D the freshness gate says unsafe and reports the lag",
    statusD.body.node?.shield?.state === "unsafe" && statusD.body.node?.shield?.lag === STALE_LAG,
    JSON.stringify(statusD.body.node?.shield),
  );
  ok(
    "D canBuildTx is false, computed server-side so the browser carries no copy of the rule",
    statusD.body.node?.canBuildTx === false,
    `canBuildTx ${JSON.stringify(statusD.body.node?.canBuildTx)}`,
  );

  // The payout itself. Before #187 this returned 200 with a txid and an explorer
  // link for a transaction whose expiry the network had already passed.
  const addrD = (await post(BASE_D, "/api/account", { kind: "shielded" })).body.account.address;
  const dripD = await claim(BASE_D, addrD, null);
  ok(
    "D a claim on a stale chain view is REFUSED, not paid with a doomed txid",
    dripD.status === 503 && dripD.body.ok !== true && !dripD.body.txid,
    `status ${dripD.status} ${JSON.stringify(dripD.body.txid ?? dripD.body.error ?? "")}`,
  );
  ok("D the refusal says it will expire rather than blaming the user", /expire/i.test(dripD.body.error ?? ""), dripD.body.error ?? "");
  ok("D the refusal carries a retry hint", typeof dripD.body.retryAfterSeconds === "number", JSON.stringify(dripD.body.retryAfterSeconds));

  // THE ONE THAT PINS THE ORDERING. The gate sits above reserveClaim, so a refusal
  // consumes no cooldown and no daily cap: our node's lag is not the user's fault
  // (#132). Move the gate below the reservation and this flips to 429, because the
  // first attempt would have booked the entitlement it then refused to honour. That
  // is a failure no amount of reading the diff makes obvious.
  const secondD = await claim(BASE_D, addrD, null);
  ok(
    "D a refused claim costs the user NOTHING: the same address is refused again, never rate-limited",
    secondD.status === 503,
    `status ${secondD.status}${secondD.status === 429 ? " (429 means the refusal consumed the cooldown, so the gate is below reserveClaim)" : ""}`,
  );

  /* ── E: a tip we CANNOT VERIFY must refuse too (#187 fail-closed) ─────── */

  // The state a boolean would have collapsed. E's node might be perfectly current,
  // and that is the point: we cannot show that it is, so we do not pay. Anyone who
  // writes `state !== "unsafe"` at a call site passes this state straight through,
  // which is why mayBuildTransaction() is the only asker.
  const statusE = await get(BASE_E, "/api/status");
  ok(
    "E the tip is genuinely unknown, not merely stale",
    statusE.body.node?.externalHeight === null && statusE.body.node?.shield?.state === "unverifiable",
    JSON.stringify({ external: statusE.body.node?.externalHeight, state: statusE.body.node?.shield?.state }),
  );
  ok("E canBuildTx is false on cannot-verify, not just on too-far-behind", statusE.body.node?.canBuildTx === false, `canBuildTx ${JSON.stringify(statusE.body.node?.canBuildTx)}`);
  // The asymmetry, and the reason it is asserted on `frozen` rather than on a 200:
  // readiness deliberately does NOT flip to frozen on a tip it cannot verify, since a
  // public-endpoint outage must never take down a healthy faucet. The money gate takes
  // the opposite view of the identical input, which is the whole design.
  //
  // E's /api/ready is 503 for an unrelated reason, and it is worth knowing why:
  // LIGHTWALLETD_ENDPOINT is both the oracle's fallback route and the app's read-side
  // backend, so the pin that makes the tip genuinely unknown also makes the backend
  // unreachable ("backend unreachable", verified). The suite already warns about this
  // trap higher up. So assert the property, not the status code it cannot show here.
  ok(
    "E readiness still fails OPEN on the same input the money gate refuses",
    statusE.body.node?.frozen === false,
    JSON.stringify({ frozen: statusE.body.node?.frozen }),
  );

  const addrE = (await post(BASE_E, "/api/account", { kind: "shielded" })).body.account.address;
  const dripE = await claim(BASE_E, addrE, null);
  ok(
    "E a claim is REFUSED when freshness cannot be established, with a healthy wallet behind it",
    dripE.status === 503 && !dripE.body.txid,
    `status ${dripE.status} ${JSON.stringify(dripE.body.txid ?? dripE.body.error ?? "")}`,
  );
  const secondE = await claim(BASE_E, addrE, null);
  ok("E the cannot-verify refusal also leaves the cooldown alone", secondE.status === 503, `status ${secondE.status}`);
} finally {
  stop(fakeHosh);
  stop(fakeHoshStale);
  stop(fakeHoshEmpty);
  stop(serverD);
  stop(walletD);
  stop(serverE);
  stop(walletE);
  stop(serverA);
  stop(serverB);
  stop(serverC);
  stop(walletA);
  stop(walletB);
  stop(walletC);
}

console.log(failures === 0 ? "\napi-integration: all green" : `\napi-integration: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
