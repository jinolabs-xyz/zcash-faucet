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
import { openSync, readFileSync, readdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bech32, bech32m } from "@scure/base";

const PORT_A = 3210;
const PORT_B = 3211;
const PORT_C = 3212;
const PORT_D = 3213;
const PORT_E = 3214;
const PORT_F = 3215; // boots only to prove it dies
const PORT_H = 3216; // H for HOUSEHOLD: several addresses behind one forwarded IP
const PORT_I = 3217; // I for the /24: the subnet cap, the one refusal that must NOT carry a clock time
const PORT_J = 3218; // J for a wallet that answers balances and FAILS every send
const PORT_K = 3219; // K for the daily CAP: one drip a day, so the refusal's clock can be read
const PORT_L = 3220; // L for the DRAIN with a send stuck in the queue (R-27)
const PORT_M = 3221; // M for the drain with an empty queue: exits at once
const PORT_N = 3222; // N for the wrong wallet credential: a 401 is a definite no, not an unknown outcome (R-41)
const PORT_O = 3223; // O for a z_sendmany reply that never arrives: the no-opid unknown (R-26), which C's hanging op is not
const PORT_P = 3224; // P for a 401 on the SEND itself: a definite failure that releases the claim, never a held one (R-41)
const PORT_Q = 3225; // Q for the one server this suite deliberately RESTARTS, to watch uptimeSeconds fall
const PORT_R = 3226; // R for a wallet that REFUSES THE RECIPIENT: the visitor's address, not our wallet (#536)
const PORT_S = 3227; // S for a wallet 8 blocks behind our node: INSIDE the drip budget, so the page is LIVE and the drip is served
const PORT_T = 3228; // T for a wallet 11 behind: over it, so the page refuses with the number and the drip is refused by the same gate
// Somewhere to keep the output of the server that is supposed to die, so the
// assertion can check WHY it died rather than only that it did.
const LOG_DIR = mkdtempSync(join(tmpdir(), "faucet-api-integration-"));
// THIS RUN OWNS ITS SERVERS (risk register II, R-40). Fixed ports and a readiness poll
// that accepted any 200 meant a server left behind by an aborted run answered for the
// new one, and the suite passed against code it did not start. Three things close it:
// a per-run nonce every server carries as FAUCET_BUILD_COMMIT and waitReady REQUIRES
// on /api/status; a per-run ledger directory, so no run reads another's claims; and
// each server's output in a file under LOG_DIR rather than discarded, so a boot that
// dies says why.
const RUN_NONCE = `api-integration-${process.pid}-${Date.now().toString(36)}`;
// The operator's token for this run, so waitReady can read buildCommit: /api/status
// hands it out only to a request carrying it (R-24). Per run, like the nonce.
const OPS_TOKEN = `ops-${RUN_NONCE}`;
const DATA_DIR = join(LOG_DIR, "data");
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_Q = `http://localhost:${PORT_Q}`;
const BASE_B = `http://localhost:${PORT_B}`;
const BASE_C = `http://localhost:${PORT_C}`;
const BASE_D = `http://localhost:${PORT_D}`;
const BASE_E = `http://localhost:${PORT_E}`;
const BASE_H = `http://localhost:${PORT_H}`;
const BASE_I = `http://localhost:${PORT_I}`;
const BASE_J = `http://localhost:${PORT_J}`;
const BASE_R = `http://localhost:${PORT_R}`;
const BASE_S = `http://localhost:${PORT_S}`;
const BASE_T = `http://localhost:${PORT_T}`;
const BASE_K = `http://localhost:${PORT_K}`;
const BASE_L = `http://localhost:${PORT_L}`;
const BASE_M = `http://localhost:${PORT_M}`;
const BASE_N = `http://localhost:${PORT_N}`;
const BASE_O = `http://localhost:${PORT_O}`;
const BASE_P = `http://localhost:${PORT_P}`;

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
// A Sapling address, which /api/account cannot mint: the recipient kind whose privacy
// policy is one line from the transparent one in zalletsend.ts, and the 2026-09-10 shape.
const SAPLING_A = bech32.encode("ztestsapling", bech32.toWords(seq(43, 9)), 1023);
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

async function solvedChallengeFrom(base, ip) {
  const { status, body } = await req(base, "/api/pow/challenge", { headers: { "x-forwarded-for": ip } });
  if (status !== 200 || !body.seed) throw new Error(`challenge fetch failed: ${status}`);
  return { seed: body.seed, difficulty: body.difficulty, exp: body.exp, sig: body.sig, nonce: solve(body) };
}
async function solvedChallenge(base) {
  const { status, body } = await get(base, "/api/pow/challenge");
  if (status !== 200 || !body.seed) throw new Error(`challenge fetch failed: ${status}`);
  return { seed: body.seed, difficulty: body.difficulty, exp: body.exp, sig: body.sig, nonce: solve(body) };
}

/* ── server lifecycle ──────────────────────────────────────────────────── */
function boot(port, env) {
  const fd = openSync(join(LOG_DIR, `server-${port}.log`), "w");
  const child = spawn("npm", ["run", "start"], {
    env: { ...process.env, PORT: String(port), FAUCET_BUILD_COMMIT: RUN_NONCE, FAUCET_OPS_TOKEN: OPS_TOKEN, FAUCET_DATA_DIR: DATA_DIR, ...env },
    stdio: ["ignore", fd, fd],
    detached: true, // own process group, so kill(-pid) reaps next too
  });
  return child;
}
/**
 * Boot a server that is EXPECTED TO DIE, and resolve {code, log}.
 *
 * Every other server here is started and polled until it answers. This one
 * asserts the opposite, so it needs the exit code rather than a readiness probe,
 * and a timeout: a process that stays up is the failure being tested for, and
 * without the timeout that failure would hang the suite instead of reporting.
 */
function bootExpectingExit(port, env, logPath, ms = 60_000) {
  return new Promise((resolve) => {
    const fd = openSync(logPath, "w");
    const childEnv = { ...process.env, PORT: String(port), ...env };
    // Explicitly absent, not merely unset by us: an ambient salt in the runner
    // would make this test pass while proving nothing.
    delete childEnv.RATE_LIMIT_SALT;
    const child = spawn("npm", ["run", "start"], { env: childEnv, stdio: ["ignore", fd, fd], detached: true });
    const timer = setTimeout(() => {
      stop(child);
      resolve({ code: "TIMEOUT", log: readFileSync(logPath, "utf8") });
    }, ms);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, log: readFileSync(logPath, "utf8") });
    });
  });
}

/**
 * Poll the tip-oracle fixture until it answers, so no app can out-race it.
 *
 * @param expectTestnetRow when true (the default) we additionally require a usable
 *   testnet row, because a 200 with an unusable body would let the oracle's
 *   fallback fire anyway - the failure this wait exists to prevent.
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
  let stranger = null;
  for (;;) {
    try {
      // /api/status, not /api/health: the answer has to carry THIS run's nonce, or it is
      // some other process on the port and the run must not proceed against it. Eight
      // seconds, because status probes the read-side backend with its own 4 s budget:
      // with egress blackholed a 200 takes 4.03 s (review of #537), and a 2 s abort here
      // read a healthy server as one that never came up.
      const res = await fetch(base + "/api/status", { signal: AbortSignal.timeout(8000), headers: { "x-faucet-ops": OPS_TOKEN } });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.buildCommit === RUN_NONCE) return;
        stranger = body.buildCommit ?? "no buildCommit";
      }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(stranger != null
        ? `a server at ${base} answers with buildCommit ${JSON.stringify(stranger)}, not this run's ${RUN_NONCE}: something else is on the port, stop it before running the suite`
        : `server at ${base} did not come up (its output is in ${LOG_DIR})`);
    }
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
// THE DOUBLES DEMAND CREDENTIALS (risk register II, R-41). The real wallet always does,
// and a double that did not could never have caught an app that forgot the header.
// One password per run; the app is given the same one, except server N below.
const RPC_PASSWORD = `pw-${RUN_NONCE}`;
const wallet = (port, balanceTaz, extra = {}) =>
  spawn("node", ["scripts/fake-zallet.mjs"], {
    env: { ...process.env, PORT: String(port), BALANCE_TAZ: String(balanceTaz), RPC_USER: "faucet", RPC_PASSWORD, ...extra },
    stdio: "ignore",
    detached: true,
  });
// C's wallet accepts the send and then never finishes the operation, which is
// the shape of the hang the queue deadline exists for (#88).
const WALLET_C = 28323;
const walletA = wallet(WALLET_A, 10);
const walletB = wallet(WALLET_B, 0);
const walletC = spawn("node", ["scripts/fake-zallet.mjs"], {
  env: { ...process.env, PORT: String(WALLET_C), BALANCE_TAZ: "10", SEND_HANGS: "true", RPC_USER: "faucet", RPC_PASSWORD },
  stdio: "ignore",
  detached: true,
});

// D's wallet is healthy and well funded. The ONLY thing wrong with D is that the
// network has moved 40 blocks past our node, which is the tx 29 lag exactly.
const WALLET_D = 28325;
const walletD = wallet(WALLET_D, 10);
// H's wallet is plain and funded; what is special about H is only its env.
const WALLET_H = 28329; // 28327 was E's, and the second fake-zallet died silently on EADDRINUSE
const walletH = wallet(WALLET_H, 10);
const WALLET_I = 28330;
const walletI = wallet(WALLET_I, 10);
// J's wallet reads a healthy balance and refuses every send: the "balance reads, send
// throws" state the send-health verdict exists for.
const WALLET_J = 28331;
const walletJ = spawn("node", ["scripts/fake-zallet.mjs"], {
  env: { ...process.env, PORT: String(WALLET_J), BALANCE_TAZ: "10", SEND_FAILS: "true", RPC_USER: "faucet", RPC_PASSWORD },
  stdio: "ignore",
  detached: true,
});
// E's wallet is healthy too. E's oracle is the one that has nothing to say.
// R's wallet is funded and healthy and refuses the RECIPIENT: -8 with wording that IS on
// RECIPIENT_REFUSALS. Nothing committed drove that branch before (#536), so the split between
// "your address is wrong" (400, reservation released) and "our wallet is broken" (502) was
// never exercised end to end, and the 400 is the one a visitor can act on.
const WALLET_R = 28338;
const walletR = spawn("node", ["scripts/fake-zallet.mjs"], {
  env: { ...process.env, PORT: String(WALLET_R), BALANCE_TAZ: "10", REFUSE_PREFIX: "utest1", RPC_USER: "faucet", RPC_PASSWORD },
  stdio: "ignore",
  detached: true,
});

// S and T: the ONLY thing wrong with either is where the wallet's scan sits under the node -
// 8 blocks for S, 11 for T - which is the drip gate's budget of 10 from both sides.
const WALLET_S = 28339;
const WALLET_T = 28340;
const walletS = wallet(WALLET_S, 10, { WALLET_LAG: "8" });
const walletT = wallet(WALLET_T, 10, { WALLET_LAG: "11" });
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
// HOSH_URL is the fixture, and TIP_ORACLE_ENDPOINT is EMPTY so the oracle's direct leg
// never runs. That second line used to be unnecessary and is now load-bearing: the oracle
// fetches both references every refresh, so without it every server here would dial the
// real testnet.zec.rocks, learn a tip ~700,000 blocks above the fixture's, judge its own
// node against the higher one and read as frozen. The comment this replaces said the
// direct route "is never taken because the fixture always answers", which stopped being
// true the moment both references were fetched in parallel.
//
// Pinning LIGHTWALLETD_ENDPOINT at a closed port instead is still NOT safe, and that is
// why the oracle now has its own variable: the backend one is also the app's read side,
// so breaking it makes readiness report "backend unreachable" and fails a different
// assertion. Verified by doing exactly that and watching it fail.
const chainView = {
  HOSH_URL: `http://127.0.0.1:${HOSH_PORT}/`,
  TIP_ORACLE_ENDPOINT: "",
};

const zallet = (rpcPort) => ({
  FAUCET_SENDER: "zallet",
  ZALLET_RPC_URL: `http://127.0.0.1:${rpcPort}/`,
  ZALLET_RPC_USER: "faucet",
  ZALLET_RPC_PASSWORD: RPC_PASSWORD,
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
  // One slot, so the hung send below fills the queue and the next claim is refused
  // "busy": the shape risk register II R-19 is about.
  SEND_QUEUE_MAX_PENDING: "1",
});

// D: a healthy wallet behind a stale chain view. Challenge off so a claim is one
// POST, which keeps the cooldown assertion below about the gate and nothing else.
const serverD = boot(PORT_D, {
  ...zallet(WALLET_D),
  HOSH_URL: `http://127.0.0.1:${HOSH_STALE_PORT}/`,
  // EMPTY, for the reason the chainView comment gives, and this server is where it bites
  // hardest: D's whole scenario is "the fixture says we are 40 blocks behind". With the
  // direct leg live it dialled the real network, learned a tip 700,000 blocks higher,
  // judged D against THAT and read frozen - correct behaviour from the new rule, and the
  // wrong chain view for this test. Measured: externalHeight 4,350,247 against a fixture
  // of 3,650,000.
  TIP_ORACLE_ENDPOINT: "",
  FAUCET_CHALLENGE: "none",
});

// E: a healthy wallet whose chain view cannot be established at all. The oracle must have
// NO second route to a real tip, which is the only way "unknown" stays unknown.
const serverE = boot(PORT_E, {
  ...zallet(WALLET_E),
  HOSH_URL: `http://127.0.0.1:${HOSH_EMPTY_PORT}/`,
  // The closed loopback port stays as the READ-SIDE backend, which is what makes this
  // server's backend unreachable; the oracle is stood down by its own variable now rather
  // than by relying on the independence filter to reject a loopback address. Same result
  // today, said out loud instead of inferred.
  LIGHTWALLETD_ENDPOINT: "https://127.0.0.1:28399",
  TIP_ORACLE_ENDPOINT: "",
  FAUCET_CHALLENGE: "none",
});

// H: THE HOUSEHOLD. The per-IP allowance is the headline of #480, and nothing exercised
// it over HTTP: server A does not trust a forwarded IP, so every claim there has ipHash
// null and the IP rule is skipped by design. Review measured the cost - deleting the one
// line that wires config.ipDailyMax into the route left the whole suite green. This
// server trusts one proxy hop (what Caddy is in production), pins the allowance at 2 so
// the ceiling is reachable in three claims, and runs with the challenge off so each claim
// is one POST and the assertions are about the ledger and nothing else.
const serverH = boot(PORT_H, {
  ...zallet(WALLET_H),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  TRUSTED_PROXY_COUNT: "1",
  FAUCET_IP_DAILY_MAX: "2",
  // The per-run byte varies the HOST octet only, so every local run still lands its
  // claims in the same two /24s on the shared ledger; at the default 20 the subnet cap
  // fired on the eleventh run and every H assertion went red for a rule H is not about.
  FAUCET_SUBNET_DAILY_MAX: "100000",
});
// THE SUBNET REFUSAL, which no server above can produce: H pins the /24 cap out of
// reach on purpose. Its retryAfterSeconds is a fixed hour, not a measured expiry, so
// the route withholds nextAt for it - and `const measured = kind === "cooldown"` in
// route.ts survived every test at every layer, because nothing ever tripped this cap
// through the shipped route (#484). Allowance per IP is wide so the only rule that can
// refuse the third claim is the /24.
const serverI = boot(PORT_I, {
  ...zallet(WALLET_I),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  TRUSTED_PROXY_COUNT: "1",
  FAUCET_IP_DAILY_MAX: "5",
  FAUCET_SUBNET_DAILY_MAX: "2",
});
// J: sends fail, the verdict must reach the endpoint the page polls and the claim route
// must refuse before proof-of-work (risk register II, R-32). Challenge ON here, because
// the point is that no proof is asked for or counted once the wallet is judged.
// K: a healthy wallet under a daily cap of exactly one drip. The cap is per network and
// the ledger is shared with every server here, so K's first claim may already be the
// refused one; the assertions are about the refusal's shape, not which claim it lands on.
const WALLET_K = 28332;
const walletK = wallet(WALLET_K, 10);
const serverK = boot(PORT_K, {
  ...zallet(WALLET_K),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  FAUCET_DAILY_CAP_TAZ: "0.1",
  FAUCET_DRIP_TAZ: "0.1",
  RATE_LIMIT_SALT: "integration-test-salt-k",
  TRUSTED_PROXY_COUNT: "1",
  FAUCET_IP_DAILY_MAX: "10",
  FAUCET_SUBNET_DAILY_MAX: "100000",
});
// L and M own their SIGTERM (NEXT_MANUAL_SIG_HANDLE): the app drains before exiting
// (R-27). L's wallet never finishes a send, so its queue stays busy and the drain has to
// give up at its bound; M's is healthy, so an empty queue lets it exit at once.
//
// BOOTED THE WAY THE CONTAINER BOOTS: node running next directly, so the process we
// signal is the process docker signals (the Dockerfile's exec-form CMD makes node PID 1).
// `npm run start` puts npm and, on Linux, a non-exec'ing sh above node, and a SIGTERM
// to npm never reached node there; the first version of this test found the listener
// with lsof and signalled it directly, which proved a path docker does not take.
const bootDirect = (port, env) => {
  // ONE fd for both streams, as boot() does: two fds on one file ("w" and "a") let a
  // stdout write land at its own offset over bytes stderr had appended, and Next's own
  // errors go to stderr, which is the text a dead boot needs to keep (review of #537).
  const fd = openSync(join(LOG_DIR, `server-${port}.log`), "w");
  return spawn("node", ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", String(port)], {
    env: { ...process.env, PORT: String(port), FAUCET_BUILD_COMMIT: RUN_NONCE, FAUCET_OPS_TOKEN: OPS_TOKEN, FAUCET_DATA_DIR: DATA_DIR, ...env },
    stdio: ["ignore", fd, fd],
  });
};
const WALLET_L = 28333;
const walletL = spawn("node", ["scripts/fake-zallet.mjs"], {
  env: { ...process.env, PORT: String(WALLET_L), BALANCE_TAZ: "10", SEND_HANGS: "true", RPC_USER: "faucet", RPC_PASSWORD },
  stdio: "ignore",
  detached: true,
});
const serverL = bootDirect(PORT_L, {
  ...zallet(WALLET_L),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  SEND_TASK_DEADLINE_MS: "1500",
  ZALLET_OP_TIMEOUT_MS: "600000",
  NEXT_MANUAL_SIG_HANDLE: "true",
  FAUCET_DRAIN_MAX_MS: "3000",
  RATE_LIMIT_SALT: "integration-test-salt-l",
});
const WALLET_M = 28334;
const walletM = wallet(WALLET_M, 10);
const serverM = bootDirect(PORT_M, {
  ...zallet(WALLET_M),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  NEXT_MANUAL_SIG_HANDLE: "true",
  FAUCET_DRAIN_MAX_MS: "10000",
  RATE_LIMIT_SALT: "integration-test-salt-m",
});
// N: the app has the WRONG wallet password. The wallet answers 401 to everything, so
// the balance reads null, readiness refuses, and a claim is refused before any send:
// the node's height is unknown, so the freshness gate says no. What N proves is the
// balance and readiness handling; the send path's own 401 is P's.
const WALLET_N = 28335;
const walletN = wallet(WALLET_N, 10);
const serverN = boot(PORT_N, {
  ...zallet(WALLET_N),
  ...chainView,
  ZALLET_RPC_PASSWORD: "not-the-password",
  FAUCET_CHALLENGE: "none",
  RATE_LIMIT_SALT: "integration-test-salt-n",
});
// O: the wallet swallows z_sendmany past the app's RPC timeout. The app cannot know
// whether the wallet spawned the operation before the socket died, so the answer must
// be the 504 "may be on their way", never a release that pays twice (R-26).
const WALLET_O = 28336;
const walletO = wallet(WALLET_O, 10, { STALL_METHOD: "z_sendmany", STALL_MS: "6000" });
const serverO = boot(PORT_O, {
  ...zallet(WALLET_O),
  ...chainView,
  ZALLET_RPC_TIMEOUT_MS: "1500",
  FAUCET_CHALLENGE: "none",
  RATE_LIMIT_SALT: "integration-test-salt-o",
});
// P: the credential works for everything but z_sendmany. The balance reads, the node
// looks fine, the claim reaches the send, and the wallet says 401 there: HTTP 4xx on
// z_sendmany is a DEFINITE failure in sendmanyFailureIsDefinite, so the claim is
// released (the address can try again at once) and the send counts as failed, not
// unknown. A wallet whose credential was rotated mid-flight looks exactly like this.
const WALLET_P = 28337;
const walletP = wallet(WALLET_P, 10, { AUTH_FAIL_METHODS: "z_sendmany" });
const serverP = boot(PORT_P, {
  ...zallet(WALLET_P),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  RATE_LIMIT_SALT: "integration-test-salt-p",
});
const serverR = boot(PORT_R, {
  ...zallet(WALLET_R),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  RATE_LIMIT_SALT: "integration-test-salt-r",
});
const serverS = boot(PORT_S, {
  ...zallet(WALLET_S),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  RATE_LIMIT_SALT: "integration-test-salt-s",
});
const serverT = boot(PORT_T, {
  ...zallet(WALLET_T),
  ...chainView,
  FAUCET_CHALLENGE: "none",
  RATE_LIMIT_SALT: "integration-test-salt-t",
});
const serverJ = boot(PORT_J, {
  ...zallet(WALLET_J),
  ...chainView,
  FAUCET_CHALLENGE: "pow",
  FAUCET_POW_BITS: "8",
  FAUCET_POW_ESCALATE_BITS: "2",
  RATE_LIMIT_SALT: "integration-test-salt-j",
  TRUSTED_PROXY_COUNT: "1",
  FAUCET_IP_DAILY_MAX: "10",
  FAUCET_SUBNET_DAILY_MAX: "100000",
});

// The one server this suite restarts, hoisted out of the try so the finally can stop it: a
// throw between the two boots would otherwise leave PORT_Q bound, and the next run would
// meet its own stranger-guard (the CTO's red-team, review of #558).
let serverQ = null;

try {
  // Wait for the oracle double BEFORE the apps are usable. If an app's first
  // background tip refresh runs while the fixture is still binding, hosh yields
  // nothing, externalTip degrades to a direct lightwalletd call, and the app
  // caches the REAL network tip - 570,000 blocks above the wallet double's - so it
  // reads as frozen for the rest of the run. That is the same race that made this
  // suite pass locally and fail in CI; overriding HOSH_URL is only half the fix if
  // nothing waits for the override to be listening.
  await waitHosh();
  await waitHosh(true, 15_000, HOSH_STALE_PORT);
  // false: this fixture serves no testnet row BY DESIGN, so requiring one would
  // hang and then throw. Responding at all is the whole requirement.
  await waitHosh(false, 15_000, HOSH_EMPTY_PORT);
  await Promise.all([waitReady(BASE_A), waitReady(BASE_B), waitReady(BASE_C), waitReady(BASE_D), waitReady(BASE_E), waitReady(BASE_H), waitReady(BASE_I), waitReady(BASE_J), waitReady(BASE_K), waitReady(BASE_L), waitReady(BASE_M), waitReady(BASE_N), waitReady(BASE_O), waitReady(BASE_P), waitReady(BASE_S), waitReady(BASE_T)]);
  // THE LEDGER IS WHERE THIS RUN PUT IT. A driver that ignored FAUCET_DATA_DIR kept every
  // other assertion green while the claims went back to cwd/data (review of #537), which
  // is the shape this suite exists to refuse: a green that proves nothing.
  ok("the run's ledger is under its own data dir, not cwd/data", existsSync(join(DATA_DIR, "faucet.db")), DATA_DIR);

  /* ── A: /api/status shape ────────────────────────────────────────────── */
  const status = await get(BASE_A, "/api/status");
  ok("A GET /api/status is 200", status.status === 200);
  const s = status.body;
  ok("A status: mode is zallet+pow", s.sender === "zallet" && s.challenge === "pow", JSON.stringify({ sender: s.sender, challenge: s.challenge }));
  ok("A status: core shape", typeof s.dripTaz === "number" && typeof s.cooldownSeconds === "number" && typeof s.balanceTaz === "number" && s.empty === false && typeof s.queueDepth === "number");
  ok("A status: backend + miner blocks", typeof s.backend?.reachable === "boolean" && typeof s.miner?.active === "boolean");
  // THE PUBLIC VIEW NAMES NO FAULT AND NO COMMIT (risk register II, R-24). Server A has
  // no box report, so the detailed shape would say "unknown" with counts; the public
  // shape says one word and carries no buildCommit. The token buys the rest.
  ok("A status (public): box is one word, no counts, no watchdog or pager state", s.box && ["ok", "attention", "unknown"].includes(s.box.state) && !("expected" in s.box) && !("watchdogUnit" in s.box) && !("alertBridge" in s.box), JSON.stringify(s.box));
  ok("A status (public): no buildCommit", !("buildCommit" in s), JSON.stringify(Object.keys(s)));
  const opsStatus = await req(BASE_A, "/api/status", { headers: { "x-faucet-ops": OPS_TOKEN } });
  ok("A status (operator token): buildCommit is this run's nonce", opsStatus.body.buildCommit === RUN_NONCE, JSON.stringify(opsStatus.body.buildCommit));
  ok("A status (operator token): the detailed box, with its counts and the same one-word verdict", "expected" in (opsStatus.body.box ?? {}) && "watchdogUnit" in opsStatus.body.box && ["ok", "attention", "unknown"].includes(opsStatus.body.box.verdict), JSON.stringify(opsStatus.body.box));
  // THE MINER'S EXPLANATORY DETAIL IS THE OPERATOR'S (#569). The redesign moved the public page to
  // one word and the template age - the standing rule working as intended - which left the
  // sentences an operator acts on homeless. They live behind the token now, beside the box's named
  // faults, and the pair below is what says so: present WITH the token, absent WITHOUT it.
  //
  // The public half is the one that matters more. `publicBoxRow` already promises the public
  // "detail is on the box, not here", and a detail string leaking into the public body would break
  // that promise silently - the body is 200 either way and nobody reads an extra field.
  ok("A status (operator token): the miner carries its explanatory detail",
    typeof opsStatus.body.miner?.detail === "string" && opsStatus.body.miner.detail.length > 0,
    JSON.stringify(opsStatus.body.miner?.detail ?? null));
  // AND THE SUBJECT IS PINNED IN THE ROW THAT NEEDS IT (review of #642, SDE-Infra). `"detail" in
  // (x ?? {})` is FALSE when the miner block is absent, so a body that dropped `miner` entirely
  // satisfied both of these while proving nothing - a gate that cannot fail because its subject
  // was never there. The public row leaned on :587 pinning `s.miner.active` twenty lines up, and
  // the wrong-token body had no such pin anywhere. Each row now asserts the block IS there, by a
  // field the public view is meant to keep, before asserting what it must not carry.
  ok("A status (public): and the miner does NOT, because that is the operator's surface",
    typeof s.miner?.active === "boolean" && !("detail" in s.miner), JSON.stringify(s.miner ?? null));
  // THE SAME PAIR FOR THE OPERATOR BLOCK (#666's two fields plus the recency). These are
  // the reason `operator` is a nested object on the reading rather than three more flat
  // fields: `route.ts` publishes the reading with a spread, so a flat field would be
  // public the moment it was parsed, and the only thing preventing that would be someone
  // remembering. Nested, the leak takes DELETING the destructure, and these rows see it.
  //
  // lastRejectReason is a FIXED TOKEN and never the node's text - but a fixed token is
  // still not a thing to publish, and abandonedCount says how often this miner loses
  // races, which is operator detail by the same standard as `detail` itself.
  //
  // SAME ANTI-VACUITY AS THE ROWS ABOVE (#642, SDE-Infra): assert the miner block IS
  // there, by a field the public view is meant to keep, BEFORE asserting what it must not
  // carry - otherwise a body that dropped `miner` entirely satisfies both and proves
  // nothing.
  ok("A status (operator token): the miner carries its operator block, with all three fields",
    !!opsStatus.body.miner?.operator
      && ["lastRejectReason", "abandonedCount", "abandonedAgoSeconds"].every((k) => k in opsStatus.body.miner.operator),
    JSON.stringify(opsStatus.body.miner?.operator ?? null));
  ok("A status (public): and the operator block is absent, not nulled - a reject reason is not public",
    typeof s.miner?.active === "boolean" && !("operator" in s.miner), JSON.stringify(s.miner ?? null));

  const wrongTok = await req(BASE_A, "/api/status", { headers: { "x-faucet-ops": OPS_TOKEN + "x" } });
  ok("A status (wrong token): the miner detail is withheld too, not only the commit",
    typeof wrongTok.body.miner?.active === "boolean" && !("detail" in wrongTok.body.miner),
    JSON.stringify(wrongTok.body.miner ?? null));
  ok("A status (wrong token): and the operator block is withheld with it",
    typeof wrongTok.body.miner?.active === "boolean" && !("operator" in wrongTok.body.miner),
    JSON.stringify(wrongTok.body.miner ?? null));
  ok("A status (wrong token): the public view, not an error that says a token exists", wrongTok.status === 200 && !("buildCommit" in wrongTok.body) && !("expected" in wrongTok.body.box), JSON.stringify(Object.keys(wrongTok.body)));
  ok("A status: reserve block shape", typeof s.reserve?.targetTaz === "number" && typeof s.reserve?.lowTaz === "number" && typeof s.reserve?.refilling === "boolean" && "spendableTaz" in (s.reserve ?? {}));

  /* ── A: /api/ready 200 ───────────────────────────────────────────────── */
  const readyA = await get(BASE_A, "/api/ready");
  ok("A GET /api/ready is 200 with reason null", readyA.status === 200 && readyA.body.ready === true && readyA.body.reason === null, JSON.stringify(readyA.body.reason ?? null));

  // EVERY REFERENCE NAMED, WITH ITS AGE AND WHETHER THEY AGREE (#548). One number with no
  // provenance is what let a resyncing node pass as current against a reference that was
  // 113 blocks stale. This run has exactly one source by construction - the hosh fixture,
  // with TIP_ORACLE_ENDPOINT empty so the direct leg cannot dial the real network - so it
  // pins the one-source shape: a named source with a fetch age, no spread to report, and
  // `corroborated` NULL rather than false, because one source is not disagreement. The
  // two-source and stale-source rules are unit-tested (src/lib/zcash/tipReferences.test.ts);
  // what only this layer can show is that the block survives the trip over the wire.
  const refs = readyA.body.tipReferences;
  ok("A /api/ready names each tip reference, its age and whether they agree",
    !!refs && typeof refs.sources?.hosh?.height === "number" && refs.sources.hosh.height > 0 &&
      Number.isInteger(refs.sources.hosh.ageSeconds) && refs.sources.hosh.ageSeconds >= 0 &&
      refs.sources.hosh.stale === false &&
      refs.sources.lightwalletd === undefined &&
      refs.spreadBlocks === null && refs.corroborated === null && refs.used === "hosh" &&
      // FLAT, beside the name, because the watchdog reads this with grep and cannot nest
      // (SDE-Infra's ask, writing the R-12 rung). Asserted equal to the nested value so
      // the redundancy can never become a disagreement.
      refs.usedHeight === refs.sources.hosh.height,
    JSON.stringify(refs));
  // And the node is judged against that reference rather than against a number with no
  // source: same height, arrived at through the max-over-non-stale rule.
  ok("A and node.externalHeight is the reference it says it used",
    readyA.body.node?.externalHeight === refs?.sources?.hosh?.height,
    `${readyA.body.node?.externalHeight} vs ${refs?.sources?.hosh?.height}`);

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

  // THE 30-DAY SERIES THE PAGE DRAWS. Shape and invariant rather than numbers: the
  // window is a fixed 30 UTC days oldest-first with the quiet days zero-filled, every
  // entry is a day and a count and NOTHING ELSE (there is no per-visitor field for it to
  // grow, and this is where that stays true), and the series sums to the last30d figure
  // printed beside it - a chart disagreeing with its own headline is the failure this
  // catches. Read AFTER a drip has gone out, because thirty zeros satisfy every
  // structural check while proving nothing about the counting. `today` is read either
  // side of the request so a run crossing UTC midnight compares against both candidates
  // rather than going red at 00:00Z.
  const dayBefore = new Date().toISOString().slice(0, 10);
  const dripStatus = (await get(BASE_A, "/api/status")).body.drips;
  const dayAfter = new Date().toISOString().slice(0, 10);
  const byDay = dripStatus?.byDay ?? [];

  // THE BLOCK'S OWN KEYS, NOT JUST EACH DAY'S. byDay's per-day keys have been pinned since it
  // shipped; the drips OBJECT never was - so `countingSince` was added in the db layer, reached
  // this PUBLIC body, and no test broke and nothing acknowledged it (#675, flagged by SDE-UI and
  // filed by SDE-Infra on #677). That is the same silence that left the miner's heartbeat fields
  // unread for months: a field can only be noticed here if something enumerates what is here.
  // Listed rather than counted, so the failure names the field that arrived or left.
  ok("A status: the PUBLIC drips block carries exactly the keys it is meant to",
    JSON.stringify(Object.keys(dripStatus ?? {}).sort()) === '["allTime","byDay","countingSince","last30d","last7d"]',
    JSON.stringify(Object.keys(dripStatus ?? {}).sort()));
  // And countingSince is a DATE or null - never "" and never an invented epoch, which is the
  // property #675's own db row holds one layer down and this one holds on the wire.
  ok("A status: countingSince is a UTC date or null, never an invented one",
    dripStatus?.countingSince === null || /^\d{4}-\d{2}-\d{2}$/.test(dripStatus?.countingSince ?? ""),
    JSON.stringify(dripStatus?.countingSince));
  ok("A status: drips.byDay carries today's drip and is 30 zero-filled UTC days, oldest first, summing to last30d",
    Array.isArray(byDay) && byDay.length === 30 &&
      byDay.every((d) => JSON.stringify(Object.keys(d).sort()) === '["day","sent"]' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && Number.isInteger(d.sent) && d.sent >= 0) &&
      byDay.every((d, i) => i === 0 || Date.parse(`${d.day}T00:00:00Z`) - Date.parse(`${byDay[i - 1].day}T00:00:00Z`) === 86_400_000) &&
      [dayBefore, dayAfter].includes(byDay[29].day) &&
      // The last TWO days, not today alone. If the run crosses UTC midnight between the
      // claim and this read, the drip is counted on the day that has just become
      // yesterday, and an assertion on byDay[29] alone would go red for the clock rather
      // than for the code - the same flake the day labels above are read either side of
      // the request to avoid.
      byDay[28].sent + byDay[29].sent >= 1 &&
      byDay.reduce((n, d) => n + d.sent, 0) === dripStatus.last30d,
    JSON.stringify({ len: byDay.length, first: byDay[0], last: byDay[29], last30d: dripStatus?.last30d }));

  /* ── donate page wiring (#55) ────────────────────────────────────────── */
  // The page renders entirely from /api/status, so pinning these fields is
  // what stops the donate page silently going blank on a status change.
  ok("A status carries the donation address byte for byte", s.donationAddress === DONATION_UA, `len ${s.donationAddress?.length}`);
  ok("A status carries the mining address byte for byte", s.miningAddress === MINING_TADDR, `len ${s.miningAddress?.length}`);

  const donatePage = await fetch(BASE_A + "/donate");
  const donateHtml = await donatePage.text();
  ok("A GET /donate is 200", donatePage.status === 200, `status ${donatePage.status}`);
  ok("A /donate is the donate page, not a 404 shell", /Keep the tank full/.test(donateHtml));
  // The income sentence follows the miner and the reserve loop (R-39). This server
  // has no heartbeat file, so it is the not-mining shape; the old fixed "rounds to
  // zero" must be gone.
  ok("A /donate says where the TAZ comes from, from the miner state, and the old fixed sentence is gone",
    /The faucet is not mining right now, so what it hands out is donated or topped up by hand\./.test(donateHtml) && !/rounds to zero/i.test(donateHtml),
    donateHtml.match(/The faucet (mines|is not mining)[^<]{0,120}/)?.[0] ?? "no income sentence");

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
  // THE OTHER DIRECTION OF THE COUPLING CASE B PINS, because one direction is half a property:
  // a page that said "No address configured" unconditionally would satisfy every B assertion.
  // Two controls, one per address, in the configuration where both are set.
  const copyControls = (visible.match(/Copy address/g) ?? []).length;
  ok("A /donate offers one copy control per address it has", copyControls === 2, `${copyControls} controls`);
  ok("A /donate does not claim to be missing an address it has",
    !/No address configured/i.test(visible) && !/No mining address is configured/i.test(visible));
  ok("A main page links to /donate", /href="\/donate"/.test(await (await fetch(BASE_A + "/")).text()));

  /* ── A: faucet happy path, then every rejection ──────────────────────── */
  const sent = await claim(BASE_A, tmAddr, await solvedChallenge(BASE_A));
  ok("A claim with pow to generated address is 200 + txid", sent.status === 200 && sent.body.ok === true && typeof sent.body.txid === "string" && sent.body.txid.length >= 32, `status ${sent.status} ${JSON.stringify(sent.body.error ?? "")}`);
  ok("A claim reports transparent recipient", sent.body.to?.kind === "transparent");

  const repeat = await claim(BASE_A, tmAddr, await solvedChallenge(BASE_A));
  ok("A immediate repeat is 429 with retryAfterSeconds", repeat.status === 429 && typeof repeat.body.retryAfterSeconds === "number", `status ${repeat.status}`);
  // A COOLDOWN IS NOT AN OUTAGE, and the refusal has to carry enough for a client to say
  // so. A forum user read exactly this response as the faucet being down while holding a
  // confirmed drip, so the 429 now carries a wall-clock time rather than a duration to do
  // arithmetic on, and says WHICH limit refused. What it deliberately does not carry is
  // the txid - see the assertion below.
  ok("A the 429 says WHEN, not just how long", typeof repeat.body.nextAt === "string" && !Number.isNaN(Date.parse(repeat.body.nextAt)), JSON.stringify(repeat.body.nextAt));
  // AND IT DOES NOT HAND BACK THE TXID. A first cut did, and that is an oracle: anyone who
  // knows an address can learn which transaction paid it for the price of one PoW, which
  // for a shielded recipient is a link the chain does not reveal. The browser that made
  // the claim already has the txid from its own 200 and remembers it itself.
  ok("A the 429 does NOT disclose which transaction paid the address", !("priorTxid" in repeat.body) && !/[0-9a-f]{64}/.test(JSON.stringify(repeat.body)), JSON.stringify(repeat.body));

  const bad = await claim(BASE_A, UNIFIED_BAD, await solvedChallenge(BASE_A));
  ok("A checksum-broken address is 400", bad.status === 400, `status ${bad.status}`);
  ok("A 400 names the checksum", /checksum/i.test(bad.body.error ?? ""), bad.body.error);

  // #536: THE WALLET REFUSES THE RECIPIENT, which is the visitor's address and not our wallet.
  // It has to read 400 with kind recipient, never the 502 a broken wallet gets, because those two
  // tell the visitor to do opposite things. Nothing committed drove this branch before.
  const recipRefused = await claim(BASE_R, UNIFIED_A, null);
  ok("R a recipient the wallet refuses is 400, not the 502 a broken wallet gets", recipRefused.status === 400, `status ${recipRefused.status}`);
  ok("R and it is named as the recipient's fault", recipRefused.body.kind === "recipient", JSON.stringify(recipRefused.body));
  // THE ASSERTION THAT MATTERS. A refusal releases the reservation, so the SAME address must be
  // able to try again. If it burned the cooldown this would be 429 and a visitor who fixed a typo
  // would be locked out for a day over an address we never paid.
  const recipRefusedAgain = await claim(BASE_R, UNIFIED_A, null);
  ok("R a refusal does NOT consume the cooldown", recipRefusedAgain.status === 400, `status ${recipRefusedAgain.status}`);

  /* ── S and T: LIVE means "a drip passes the wallet-lag gate" ───────────── */
  // The page used to decide readiness with its own `w >= n - 5` while the route decides a drip
  // with walletLagFreshness's budget of 10, so in the 6-to-10 band /api/ready said NOT READY and
  // visitors were turned away from a drip that would have been served. One predicate on both
  // sides now. S sits at 8 (inside the budget), T at 11 (over it): the page and the route have
  // to agree on each, and T's reason has to carry the number an operator acts on.
  const readyS = await get(BASE_S, "/api/ready");
  ok("S a wallet 8 behind our node is inside the drip budget, so /api/ready is 200 and ready",
     readyS.status === 200 && readyS.body?.ready === true,
     `status ${readyS.status} ready ${JSON.stringify(readyS.body?.ready)} reason ${JSON.stringify(readyS.body?.reason ?? null)}`);
  ok("S the lag the page measured is the lag the double set, so the row above is about 8 and not 0",
     readyS.body?.node?.nodeHeight - readyS.body?.node?.height === 8,
     `node ${readyS.body?.node?.nodeHeight} wallet ${readyS.body?.node?.height}`);
  const addrS = (await post(BASE_S, "/api/account", { kind: "shielded" })).body.account.address;
  const dripS = await claim(BASE_S, addrS, null);
  // 200 with a txid here, because the double completes the send inside the request; 202 is the
  // queued shape a slow wallet produces. Either is served; what must not appear is a 503.
  ok("S and the drip is served (ok with a txid): the page's LIVE and the route's gate are the same verdict",
     (dripS.status === 200 || dripS.status === 202) && dripS.body?.ok === true && typeof dripS.body?.txid === "string",
     `status ${dripS.status} ${JSON.stringify(dripS.body).slice(0, 160)}`);
  const readyT = await get(BASE_T, "/api/ready");
  ok("T a wallet 11 behind is over the budget, so /api/ready is 503 and names the lag",
     readyT.status === 503 && /^wallet re-scanning, 11 blocks behind our node$/.test(readyT.body?.reason ?? ""),
     `status ${readyT.status} reason ${JSON.stringify(readyT.body?.reason ?? null)}`);
  const addrT = (await post(BASE_T, "/api/account", { kind: "shielded" })).body.account.address;
  const dripT = await claim(BASE_T, addrT, null);
  ok("T and the drip is refused by the wallet-lag gate (503), so a refused page never hides a drip that would have gone",
     dripT.status === 503 && /catching up with our node/.test(dripT.body?.error ?? ""),
     `status ${dripT.status} ${JSON.stringify(dripT.body?.error ?? dripT.body).slice(0, 160)}`);

  const noPow = await claim(BASE_A, UNIFIED_A, null);
  ok("A claim without pow is 403", noPow.status === 403, `status ${noPow.status}`);

  const forged = await solvedChallenge(BASE_A);
  forged.sig = (forged.sig[0] === "0" ? "1" : "0") + forged.sig.slice(1);
  const forgedRes = await claim(BASE_A, UNIFIED_A, forged);
  ok("A claim with forged pow sig is 403", forgedRes.status === 403, `status ${forgedRes.status}`);

  /* ── A: /api/balance ─────────────────────────────────────────────────── */
  const balShielded = await post(BASE_A, "/api/balance", { address: UNIFIED_B });
  ok("A balance for shielded address: 200, private, not queryable", balShielded.status === 200 && balShielded.body.shielded === true && balShielded.body.queryable === false);
  const balBad = await post(BASE_A, "/api/balance", { address: UNIFIED_BAD });
  ok("A balance for broken address is 400", balBad.status === 400, `status ${balBad.status}`);
  // The address is not accepted in the URL (R-36): a GET with it is refused and
  // told where to put it, so nothing looked up lands in a proxy log line.
  const balGet = await get(BASE_A, "/api/balance?address=" + encodeURIComponent(UNIFIED_B));
  ok("A balance by GET is 405 and says to POST", balGet.status === 405 && /POST body/.test(balGet.body.error ?? ""), `status ${balGet.status} ${JSON.stringify(balGet.body)}`);
  const balNoBody = await post(BASE_A, "/api/balance", {});
  ok("A balance with no address in the body is 400", balNoBody.status === 400, `status ${balNoBody.status}`);
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
  // THE SENTENCE CHANGED WITH THE DESIGN, THE PROPERTY DID NOT (CTO ruling, 23:48Z). The page
  // this replaces said "No address configured" inside a bordered block; the redesigned page
  // says it in the design's own card, with the operator hint beside it. Both halves are pinned
  // because the first is what a VISITOR needs (there is nothing to send to) and the second is
  // what an OPERATOR needs (which variable to set), and a page that dropped either would still
  // match a looser pin.
  //
  // NOT WEAKENED TO A STATUS CODE OR A BARE "donate": this case exists because the page once
  // rendered an empty address box with a Copy button beside it, which is worse than saying
  // nothing, and only the SENTENCE distinguishes those two.
  //
  // SCRIPT TAGS STRIPPED FIRST, the same way case A's address checks do it. Next embeds the
  // RSC payload in the HTML, so a bare /Copy address/ against the raw document can match text
  // that no visitor is shown, and a negative assertion is exactly where that goes wrong
  // quietly.
  const visibleB = donateBHtml.replace(/<script[\s\S]*?<\/script>/g, "");
  ok("B /donate says there is nothing to send to", /No address configured/i.test(visibleB));
  ok("B /donate tells the operator which variable to set", /FAUCET_DONATION_ADDRESS/.test(visibleB));
  ok("B /donate offers no copy control for an address it does not have", !/Copy address/i.test(visibleB));
  // THE SECOND ADDRESS ON THE SAME PAGE, found by sweeping rather than by a check pointing at
  // it. This app has no mining address either, and the card-copy block had the identical
  // defect one block below the one this case caught.
  ok("B /donate says the same about the mining address it does not have",
    /No mining address is configured/i.test(visibleB));

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
  // The ledger is this run's FAUCET_DATA_DIR, shared by every server in the run and
  // thrown away with it (R-40); the fresh address is still the right shape.
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

  // A FULL QUEUE IS NOT A FAILED SEND (risk register II, R-19). The hung send holds C's
  // one slot, so a fresh claim is refused "busy" before the wallet is asked. That used
  // to be recorded as a failed send, and three of them inside fifteen minutes read as
  // "sends failing" on /api/ready: the watchdog pages on that and redeploy rolls back
  // on it, for a wallet that was never touched.
  const genC2 = await post(BASE_C, "/api/account", { type: "shielded" });
  const busy = await claim(BASE_C, genC2.body?.account?.address, null);
  ok("C with the queue full, a fresh claim is 503 busy", busy.status === 503 && /busy/i.test(busy.body.error ?? ""), `status ${busy.status} ${busy.body.error ?? ""}`);
  // A FIELD, so the page can tell "busy" from the other 503s without a regex over the
  // sentence (risk register II, R-34: they all wore one "Send failed" card).
  ok("C and the busy refusal carries kind: busy", busy.body.kind === "busy", JSON.stringify(busy.body.kind));
  const readyC = await get(BASE_C, "/api/ready");
  ok("C and a busy refusal is NOT counted as a failed send", readyC.body.sends && readyC.body.sends.failed === 0, JSON.stringify(readyC.body.sends));
  ok("C while the hung send IS still counted as unresolved", readyC.body.sends && readyC.body.sends.unknown >= 1, JSON.stringify(readyC.body.sends));

  /* ── D: a stale chain view must not pay out (#187) ────────────────────── */

  // First, that the freeze detector sees NOTHING wrong. The lag that kills a
  // transaction sits far below FREEZE_BLOCKS, so `ready`/`frozen` on the node stay
  // healthy here: if these two assertions ever start failing, the test has stopped
  // covering the gap it was written for and someone has widened FREEZE_BLOCKS or
  // narrowed the lag. /api/ready itself DOES see it now (asserted below): a node
  // measurably behind the network reads not-ready with the gate's reason, so a faucet
  // refusing every drip can no longer answer 200 to the thing that pages.
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
  ok(
    "D /api/ready is 503 with the gate's reason: a faucet that refuses every drip must not read ready",
    readyD.status === 503 && /behind the network, drips would expire/.test(readyD.body?.reason ?? ""),
    `status ${readyD.status} reason ${JSON.stringify(readyD.body?.reason ?? null)}`,
  );
  ok("D the 503 body still carries the gate for readers that want the detail", readyD.body?.node?.canBuildTx === false, `canBuildTx ${JSON.stringify(readyD.body?.node?.canBuildTx)}`);

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
  ok("D and it blames OUR node, which IS behind here, not the oracle", /catching up/i.test(dripD.body.error ?? "") && !/could not verify/i.test(dripD.body.error ?? ""), dripD.body.error ?? "");
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
  /* ── H: several addresses behind ONE forwarded IP ─────────────────────── */
  // The household case, end to end through the shipped route. Three devices, three
  // addresses, one router. The allowance on H is 2, so the first two pay and the third
  // is refused BY THE CONNECTION, with the fields the page now reads.
  // UNIQUE PER RUN, still. The ledger is per run now (R-40), so a second local run no
  // longer finds H's two slots spent; the per-run octet stays because it also keeps
  // H, I, J, K and L apart from each other inside one run, and because it costs
  // nothing. (Before R-40 a fixed address here went red on the second local run, a
  // red that CI, a clean checkout, never showed.)
  // 203.0.113.0/24 is TEST-NET-3, reserved for documentation, never routed.
  const runByte = 1 + (Date.now() % 250);
  const HOME = `203.0.113.${runByte}`;
  // A DIFFERENT subnet for the neighbour and the case test, so the /24 cap never enters
  // into what these assert.
  const AWAY = `198.51.100.${runByte}`;
  const fromHome = (address) =>
    req(BASE_H, "/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": HOME },
      body: JSON.stringify({ address }),
    });
  const freshTm = async () => (await post(BASE_H, "/api/account", { type: "transparent" })).body.account?.address ?? "";
  const dev1 = await fromHome(await freshTm());
  const dev2 = await fromHome(await freshTm());
  ok("H the first device behind the router is paid", dev1.status === 200 && typeof dev1.body.txid === "string", `status ${dev1.status} ${dev1.body.error ?? ""}`);
  ok("H the SECOND device behind the same router is paid too, which one-per-IP never allowed", dev2.status === 200 && typeof dev2.body.txid === "string", `status ${dev2.status} ${dev2.body.error ?? ""}`);
  const dev3 = await fromHome(await freshTm());
  ok("H the third is refused, so the allowance is a ceiling and not an absence of one", dev3.status === 429, `status ${dev3.status}`);
  ok("H and the refusal names the CONNECTION as a field, not only in prose", dev3.body.kind === "cooldown" && dev3.body.scope === "connection", JSON.stringify({ kind: dev3.body.kind, scope: dev3.body.scope }));
  ok("H and carries a measured nextAt, because this expiry is real", typeof dev3.body.nextAt === "string" && !Number.isNaN(Date.parse(dev3.body.nextAt)), JSON.stringify(dev3.body.nextAt));
  ok("H and discloses no transaction of anyone's", !/[0-9a-f]{64}/.test(JSON.stringify(dev3.body)), JSON.stringify(dev3.body));
  // A neighbour on a different connection is untouched by this household's ceiling.
  const nb = await req(BASE_H, "/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": AWAY },
    body: JSON.stringify({ address: await freshTm() }),
  });
  ok("H a different connection is unaffected", nb.status === 200, `status ${nb.status} ${nb.body.error ?? ""}`);
  // And the SAME address in a different letter case is the same address to the ledger.
  // Bech32 is case-insensitive by spec, and until now UTEST1... and utest1... hashed
  // apart, so one recipient could be paid twice from one connection.
  // A checksum-valid unified address minted from this run's byte, the same way the
  // file's own fixtures are; the account endpoint only mints transparent keys, and
  // base58 is case-sensitive so a tm address cannot test this at all.
  const CASE_UA = ua(runByte);
  const lower = await req(BASE_H, "/api/faucet", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": AWAY }, body: JSON.stringify({ address: CASE_UA.toLowerCase() }) });
  const upper = await req(BASE_H, "/api/faucet", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": AWAY }, body: JSON.stringify({ address: CASE_UA.toUpperCase() }) });
  ok("H a bech32 address in another letter case is the SAME address to the cooldown", lower.status === 200 && upper.status === 429 && upper.body.scope === "address", `lower ${lower.status} ${lower.body.error ?? ""}, upper ${upper.status} ${upper.body.scope ?? ""}`);

  /* ── I: three connections in ONE /24 ─────────────────────────────────── */
  // The cap on I is 2 per /24. Two neighbours are paid; the third is refused by the
  // subnet rule and nothing else (its own IP is fresh, the allowance is 5). A subnet
  // refusal says "try again tomorrow" and its retryAfterSeconds is a fixed hour; a
  // wall-clock nextAt beside that would be two times on one card, one of them invented.
  // The /24 is unique per run for the same reason H's host octet is: the ledger survives
  // between local runs, and a fixed subnet would arrive at its cap already spent.
  const SUBNET_I = `10.${runByte}.${Math.floor(Date.now() / 256) % 250}`;
  // The first cut wrote `(Date.now() >> 8) % 250`, which is negative (>> coerces to
  // int32), the octet did not parse, subnetOf() returned null, and the rule was SKIPPED:
  // three paid, and "two are paid" was green about a subnet that did not exist.
  ok("I precondition: the planted /24 is a parseable IPv4 prefix", /^10\.\d{1,3}\.\d{1,3}$/.test(SUBNET_I), SUBNET_I);
  const fromNeighbour = async (host) =>
    req(BASE_I, "/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `${SUBNET_I}.${host}` },
      body: JSON.stringify({ address: (await post(BASE_I, "/api/account", { type: "transparent" })).body.account?.address ?? "" }),
    });
  const n1 = await fromNeighbour(11);
  const n2 = await fromNeighbour(12);
  ok("I two connections in one /24 are paid", n1.status === 200 && n2.status === 200, `${n1.status} ${n1.body.error ?? ""} / ${n2.status} ${n2.body.error ?? ""}`);
  const n3 = await fromNeighbour(13);
  ok("I the third connection in the /24 is refused", n3.status === 429, `status ${n3.status} ${n3.body.error ?? ""}`);
  ok("I and the refusal is the SUBNET rule, as a field", n3.body.kind === "subnet", JSON.stringify({ kind: n3.body.kind, scope: n3.body.scope }));
  ok("I and it carries a duration but NO clock time, because a fixed hour is not a measured expiry", typeof n3.body.retryAfterSeconds === "number" && !("nextAt" in n3.body), JSON.stringify(n3.body));

  /* ── J: a wallet that fails every send ─────────────────────────────────── */
  // Three visitors each solve a proof and get a 502. After the third the faucet has
  // judged the wallet (readiness refuses on it and the watchdog pages). Before this
  // change /api/status and the page still said LIVE, and the fourth visitor solved a
  // proof at +2 bits into it. Now: status carries the verdict, and the claim route
  // refuses before the challenge is looked at, with nothing spent.
  const jIp = `192.0.2.${runByte}`; // TEST-NET-1: its own /24, away from H and I
  const fromJ = async (pow) => {
    const address = (await post(BASE_J, "/api/account", { type: "transparent" })).body.account?.address ?? "";
    return req(BASE_J, "/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": jIp },
      body: JSON.stringify({ address, ...(pow ? { pow } : {}) }),
    });
  };
  const jPow = () => solvedChallengeFrom(BASE_J, jIp);
  const j1 = await fromJ(await jPow());
  const j2 = await fromJ(await jPow());
  ok("J two sends fail as 502, each after a solved proof", j1.status === 502 && j2.status === 502, `${j1.status} ${j2.status}`);
  // TWO IS THE VERDICT on a wallet that lands nothing (R-18): the third visitor is
  // refused before the proof is verified, so their solved proof is not spent. Under
  // the three-sample rule alone this third claim was a third 502 and a third burnt
  // proof, and on a nine-drips-a-day faucet the third often arrived after the first
  // had aged out, so the verdict never came at all.
  const j3 = await fromJ(await jPow());
  ok("J the third, with a solved proof, is refused by the gate: two strangers failing in a row is the wallet", j3.status === 503 && j3.body.kind === "sends", `${j3.status} ${j3.body.kind ?? ""}`);
  const statusJ = await get(BASE_J, "/api/status");
  ok("J /api/status now carries the send-health verdict the page can read", statusJ.body.sends?.state === "degraded" && statusJ.body.sends.failed === 2 && statusJ.body.sends.ok === 0, JSON.stringify(statusJ.body.sends));
  const readyJ = await get(BASE_J, "/api/ready");
  ok("J and /api/ready agrees", readyJ.status === 503 && /sends failing/.test(readyJ.body.reason ?? ""), `${readyJ.status} ${readyJ.body.reason ?? ""}`);
  // The next visitor: no proof solved, a bare POST. Refused by the send-health gate
  // BEFORE the challenge step, so the answer is 503 with the sends kind, not 403.
  const j4 = await fromJ(null);
  ok("J a claim with no proof is refused by the send-health gate, 503, before the challenge is asked for", j4.status === 503 && j4.body.kind === "sends", `${j4.status} ${JSON.stringify(j4.body)}`);
  ok("J and it says nothing was claimed and no proof was spent, with a retry-after", /no proof-of-work was spent/.test(j4.body.error ?? "") && typeof j4.body.retryAfterSeconds === "number", JSON.stringify(j4.body));
  // And the challenge difficulty did not climb for the refusal. WITH A SOLVED PROOF on
  // the refused claim: a bare POST is refused before verifySolution with or without the
  // gate (403 "proof required"), so it proved nothing about escalation; review deleted
  // the gate and this stayed green. A solved proof is what the gate must turn away
  // before it is verified and counted: gate present, 503 and 14 -> 14; gate absent,
  // verified, recorded, 502 and 14 -> 16.
  const chalBefore = (await req(BASE_J, "/api/pow/challenge", { headers: { "x-forwarded-for": jIp } })).body;
  const j5 = await fromJ(await jPow());
  const chalAfter = (await req(BASE_J, "/api/pow/challenge", { headers: { "x-forwarded-for": jIp } })).body;
  ok("J a claim WITH a solved proof is still refused by the gate, not by the wallet", j5.status === 503 && j5.body.kind === "sends", `${j5.status} ${j5.body.kind ?? ""}`);
  ok("J a refusal that was ours does not escalate the next challenge", chalBefore.difficulty === chalAfter.difficulty, `${chalBefore.difficulty} -> ${chalAfter.difficulty}`);

  // ── K: THE DAILY CAP SAYS WHEN (risk register II, R-34) ────────────────────────
  // "Come back tomorrow" was the whole answer. The cap is a rolling 24 h sum, so the
  // refusal now carries the earliest expiry among the drips it counts, as a duration
  // and as a clock time, the same two fields the connection refusal has sent since the
  // per-IP window landed. The page renders the time and offers no Try again.
  const kIp = `192.0.3.${runByte}`; // TEST-NET-2, its own /24
  const fromK = async () => {
    const address = (await post(BASE_K, "/api/account", { type: "transparent" })).body.account?.address ?? "";
    return req(BASE_K, "/api/faucet", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": kIp }, body: JSON.stringify({ address }) });
  };
  let capped = await fromK();
  if (capped.status === 200) capped = await fromK(); // the cap is per network over the run's shared ledger, and the servers before K have usually filled it
  const capNextMs = capped.body.nextAt ? Date.parse(capped.body.nextAt) : NaN;
  ok("K a claim over the daily cap is 503 kind cap", capped.status === 503 && capped.body.kind === "cap", `${capped.status} ${capped.body.kind ?? ""}`);
  // Bounded, not measured: a fresh drip frees in ~86,400 s either way, so this cannot
  // tell measured from fixed. The unit test (dailyCapRetry.test.ts) is what does.
  ok("K and it carries a retryAfterSeconds inside the day", typeof capped.body.retryAfterSeconds === "number" && capped.body.retryAfterSeconds > 0 && capped.body.retryAfterSeconds <= 86_400, JSON.stringify(capped.body.retryAfterSeconds));
  ok("K and when, as a clock time that agrees with the duration", Number.isFinite(capNextMs) && Math.abs(capNextMs - Date.now() - (capped.body.retryAfterSeconds ?? 0) * 1000) < 5_000, `${capped.body.nextAt} vs +${capped.body.retryAfterSeconds}s`);

  // ── L and M: THE PROCESS DRAINS BEFORE IT DIES (risk register II, R-27) ──────────
  // Every merge recreates the container and compose stops the old one with SIGTERM.
  // The app owns that signal now: new claims are refused with a 503 the page renders
  // as a countdown, the send queues are given a bounded wait, and only then does the
  // process exit. The signal goes to the process we spawned, which IS next-server
  // here (bootDirect), the way docker delivers it to PID 1.
  const portOpen = async (base) => { try { await fetch(base + "/api/health", { signal: AbortSignal.timeout(500) }); return true; } catch { return false; } };
  const untilClosed = async (base, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (!(await portOpen(base))) return Date.now() - t0; await new Promise((r) => setTimeout(r, 100)); } return null; };
  const lIp = `192.0.4.${runByte}`;
  const fromL = async () => {
    const address = (await post(BASE_L, "/api/account", { type: "transparent" })).body.account?.address ?? "";
    return req(BASE_L, "/api/faucet", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": lIp }, body: JSON.stringify({ address }) });
  };
  const stuck = await fromL();
  ok("L a hung send is a 504 and the queue keeps its slot", stuck.status === 504 && (await get(BASE_L, "/api/status")).body.queueDepth === 1, `status ${stuck.status}`);
  const lSignalled = Date.now();
  process.kill(serverL.pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  const refused = await fromL();
  ok("L after SIGTERM the app is still up and refuses a new claim as restarting, before any gate", refused.status === 503 && refused.body.kind === "restarting" && refused.body.retryAfterSeconds === 20, `${refused.status} ${refused.body.kind ?? ""} ${refused.body.error ?? ""}`);
  const lClosedAfter = await untilClosed(BASE_L, 12_000);
  ok("L with the queue still busy it exits at its 3 s bound, not before and not never", lClosedAfter != null && Date.now() - lSignalled >= 2_800 && Date.now() - lSignalled < 9_000, `closed after ${lClosedAfter}ms (signalled ${Date.now() - lSignalled}ms ago)`);
  const mSignalled = Date.now();
  process.kill(serverM.pid, "SIGTERM");
  const mClosedAfter = await untilClosed(BASE_M, 8_000);
  ok("M with an empty queue it exits at once, well inside its 10 s bound", mClosedAfter != null && Date.now() - mSignalled < 3_000, `closed after ${mClosedAfter}ms`);

  /* ── Q: the process says how old it is, and says a SMALLER number after a restart ─── */
  // THE PROPERTY A MONOTONIC CHECK CANNOT SEE, and the reason this field exists. On
  // 2026-09-15 a deploy was reported stalled for an hour because `reserve.blindTicks` was
  // read as a clock: it climbed 3 -> 45 -> 59 across two-minute samples while resetting
  // three times in the gaps, since it ticks every 30 s and a container swap takes about
  // ten. A counter that only ever climbs reports the same shape for three restarts and for
  // none. So this is the one server the suite deliberately kills and boots again.
  const bootQ = () => boot(PORT_Q, { ...zallet(WALLET_A), ...chainView, FAUCET_CHALLENGE: "none" });
  serverQ = bootQ();

  // THE COUNT IS THE PROCESS'S AGE, NOT THE AGE OF THE MODULE THAT ANSWERED, and this is
  // the one assertion that can tell those apart (SDE-Infra's finding on review: they
  // mutated the route to a module-scope `const START = Date.now()` and every other check
  // here passed, because a module clock also resets when the process is replaced).
  //
  // So the readiness poll below is /api/health, DELIBERATELY: it does not load the status
  // route, which means the read four seconds later is the first request that has ever
  // loaded that module. A process clock reads about 5 there; a module clock reads 0.
  //
  // THIS ONE DEPENDS ON NEXT EVALUATING ROUTE MODULES LAZILY, on first request. If a future
  // Next, or an `output` mode that pre-warms every route, loaded them at boot, a module
  // clock would start at boot too, this check would stop discriminating - and it would go
  // on passing, which is the worst way for a check to stop working. The other assertions
  // here do not depend on it. Named rather than guarded: there is nothing to assert about a
  // framework's internal timing that would not itself be a guess (the CTO's red-team).
  // Measured before choosing the margin - health answers at 0.64 s, the first status read
  // lands at 1.22 s with uptimeSeconds 1, and after this wait it is 5 - so asserting
  // against the boot duration alone would have left about a second of slack, which npm's
  // own startup could eat on a loaded runner. Four seconds cannot be eaten.
  {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const r = await req(BASE_Q, "/api/health", {}).catch(() => ({ status: 0 }));
      if (r.status === 200) break;
      if (Date.now() > deadline) throw new Error(`server at ${BASE_Q} never answered /api/health (output in ${LOG_DIR})`);
      await new Promise((r2) => setTimeout(r2, 200));
    }
  }
  await new Promise((r) => setTimeout(r, 4000));
  const q1 = await get(BASE_Q, "/api/status");
  ok("Q the first request to the status route reports the PROCESS's age, not the module's",
    q1.body.uptimeSeconds >= 4,
    `uptimeSeconds ${q1.body.uptimeSeconds} on the first status request, four seconds after the process answered health`);
  // The stranger-on-the-port guard waitReady would normally give us, kept by hand because
  // this server is deliberately not probed through /api/status.
  const q1ops0 = await req(BASE_Q, "/api/status", { headers: { "x-faucet-ops": OPS_TOKEN } });
  ok("Q and it is this run's server rather than something else on the port", q1ops0.body.buildCommit === RUN_NONCE, JSON.stringify(q1ops0.body.buildCommit));
  ok("Q uptimeSeconds is a whole-second count the public body carries", Number.isInteger(q1.body.uptimeSeconds) && q1.body.uptimeSeconds >= 0, JSON.stringify(q1.body.uptimeSeconds));
  ok("Q and the exact instant is operator-only, like buildCommit", !("startedAt" in q1.body), JSON.stringify(Object.keys(q1.body).filter((k) => k.startsWith("start"))));
  const q1ops = await req(BASE_Q, "/api/status", { headers: { "x-faucet-ops": OPS_TOKEN } });
  ok("Q the token buys startedAt, and it parses as the instant the count implies",
    typeof q1ops.body.startedAt === "string" &&
      Math.abs(Date.now() - Date.parse(q1ops.body.startedAt) - q1ops.body.uptimeSeconds * 1000) < 2000,
    JSON.stringify({ startedAt: q1ops.body.startedAt, uptimeSeconds: q1ops.body.uptimeSeconds }));

  await new Promise((r) => setTimeout(r, 1200));
  const tBefore = Date.now();
  const q2 = await get(BASE_Q, "/api/status");
  // STRICT, and the 1200 ms sleep above is what makes it deterministic: with >= a constant
  // satisfies this AND the falling check below (a fixed 42 is >= 42, and 42 < 42 + elapsed),
  // so the pair would pass over a field that never moves at all (the CTO's red-team).
  ok("Q it rises while the process runs", q2.body.uptimeSeconds > q1.body.uptimeSeconds, `${q1.body.uptimeSeconds} then ${q2.body.uptimeSeconds}`);

  // Restart, and assert the count did NOT simply carry on. Comparing the two readings
  // directly would be a coin flip - both are single digits - so the assertion is against
  // what an unrestarted process WOULD have reported by now, which the boot's own duration
  // puts comfortably out of reach.
  stop(serverQ);
  await untilClosed(BASE_Q, 10_000);
  serverQ = bootQ();
  await waitReady(BASE_Q);
  const q3 = await get(BASE_Q, "/api/status");
  const wouldBe = q2.body.uptimeSeconds + Math.round((Date.now() - tBefore) / 1000);
  ok("Q and it FALLS across a restart rather than carrying on, which is what makes a restart visible",
    q3.body.uptimeSeconds < wouldBe - 1,
    `after the restart ${q3.body.uptimeSeconds}, an unrestarted process would read about ${wouldBe}`);
  stop(serverQ);

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
  // The asymmetry with D, on the endpoint itself. Unsafe (D) is our node measurably
  // behind and 503s. Unverifiable (E) is an oracle we cannot reach, and it stays 200
  // because redeploy rolls back on this code and a public endpoint's outage must not be
  // able to roll back a good deploy. The refusal is not hidden: canBuildTx:false rides in
  // the body, and the watchdog and the live probe page on exactly that.
  // E's lightwalletd is pinned to a closed port to keep the tip unknown, so readiness here
  // is 503 for "backend unreachable" whatever the gate does: this stack CANNOT show that an
  // unverifiable tip keeps readiness at 200. That property is pinned where it can fail,
  // in src/lib/readiness.test.ts. What this stack can show is the body the pagers read.
  const readyE = await get(BASE_E, "/api/ready");
  ok(
    "E the body says the send gate is refusing, which is what the pagers read",
    readyE.body?.node?.canBuildTx === false && readyE.body?.node?.shield?.state === "unverifiable",
    JSON.stringify({ canBuildTx: readyE.body?.node?.canBuildTx, state: readyE.body?.node?.shield?.state }),
  );

  const addrE = (await post(BASE_E, "/api/account", { kind: "shielded" })).body.account.address;
  const dripE = await claim(BASE_E, addrE, null);
  ok(
    "E a claim is REFUSED when freshness cannot be established, with a healthy wallet behind it",
    dripE.status === 503 && !dripE.body.txid,
    `status ${dripE.status} ${JSON.stringify(dripE.body.txid ?? dripE.body.error ?? "")}`,
  );
  ok(
    "E and the refusal blames the unverified tip, not our node (D's wording is for a node that IS behind)",
    /could not verify the network/i.test(dripE.body.error ?? "") && !/catching up/i.test(dripE.body.error ?? ""),
    dripE.body.error ?? "",
  );
  const secondE = await claim(BASE_E, addrE, null);
  ok("E the cannot-verify refusal also leaves the cooldown alone", secondE.status === 503, `status ${secondE.status}`);

  /* ── N and the doubles: what the wallet double refuses (R-41) ──────────── */
  // THE DOUBLE BOUNDS WHAT A TEST CAN PROVE. Until now it answered anyone (so an app
  // that forgot the Authorization header passed every case here), said "success" for an
  // opid it never issued, paid a transparent address under any privacy policy, and had
  // no getblockchaininfo. One assertion per rule, against the double directly where the
  // rule is the double's, and through the app where the app's handling is the point.
  const rpcRaw = async (port, method, params = [], auth = { user: "faucet", password: RPC_PASSWORD }) => {
    const headers = { "content-type": "application/json" };
    if (auth) headers.authorization = "Basic " + Buffer.from(`${auth.user}:${auth.password}`).toString("base64");
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const noAuth = await rpcRaw(WALLET_A, "getwalletstatus", [], null);
  ok("double: no credentials is 401 with no JSON-RPC envelope, as the real wallet answers", noAuth.status === 401 && noAuth.body === null, `status ${noAuth.status}`);
  const badAuth = await rpcRaw(WALLET_A, "getwalletstatus", [], { user: "faucet", password: "wrong" });
  ok("double: the wrong password is 401 too", badAuth.status === 401, `status ${badAuth.status}`);
  // Every claim above went through this wallet with the run's credential, which is
  // the proof the app attaches the header; the direct call is the proof the double
  // would have noticed if it had not.
  const unknownOp = await rpcRaw(WALLET_A, "z_getoperationstatus", [["opid-never-issued"]]);
  ok("double: an opid it never issued is an empty list, not success", Array.isArray(unknownOp.body?.result) && unknownOp.body.result.length === 0, JSON.stringify(unknownOp.body));
  const unknownRes = await rpcRaw(WALLET_A, "z_getoperationresult", [["opid-never-issued"]]);
  ok("double: and its result is empty as well", Array.isArray(unknownRes.body?.result) && unknownRes.body.result.length === 0, JSON.stringify(unknownRes.body));
  // zallet's privacy lattice, in zallet's sentences (zallet_core.ftl), code -8: the shape
  // the app's recipient-refusal classifier (#531) matches in production. A -4 with an
  // invented sentence sent the app down the "wallet failed" branch instead (review of #544).
  const noPolicy = await rpcRaw(WALLET_A, "z_sendmany", ["utest1testfaucet", [{ address: MINING_TADDR, amount: 0.1 }], 0, null, "FullPrivacy"]);
  const REC = (policy) => `THIS MAY AFFECT YOUR PRIVACY. Resubmit with the 'privacyPolicy' parameter set\nto '${policy}' or weaker if you wish to allow this transaction to proceed\nanyway.`;
  ok("double: a transparent recipient under FullPrivacy is -8 with zallet's PRODUCTION string, line breaks and recommendation included", noPolicy.body?.error?.code === -8 && noPolicy.body.error.message === "This transaction would have transparent recipients, which is not enabled by\ndefault because it will publicly reveal transaction recipients and amounts. " + REC("AllowRevealedRecipients"), JSON.stringify(noPolicy.body));
  const amountsOnly = await rpcRaw(WALLET_A, "z_sendmany", ["utest1testfaucet", [{ address: MINING_TADDR, amount: 0.1 }], 0, null, "AllowRevealedAmounts"]);
  ok("double: AllowRevealedAmounts does NOT pay a transparent address either, as in zallet's lattice", amountsOnly.body?.error?.code === -8, JSON.stringify(amountsOnly.body));
  const saplingFull = await rpcRaw(WALLET_A, "z_sendmany", ["utest1testfaucet", [{ address: SAPLING_A, amount: 0.1 }], 0, null, "FullPrivacy"]);
  ok("double: a Sapling recipient under FullPrivacy is -8 with zallet's production string, the 2026-09-10 shape", saplingFull.body?.error?.code === -8 && saplingFull.body.error.message === "Could not send to the Sapling shielded pool without spending non-Sapling\nfunds, which would reveal transaction amounts. " + REC("AllowRevealedAmounts"), JSON.stringify(saplingFull.body));
  // And through the app: the app sends AllowRevealedAmounts for Sapling, which the
  // double accepts, so a Sapling drip lands. A regression to FullPrivacy on that line
  // is now a refusal here rather than two silent 502s on the box.
  const saplingClaim = await post(BASE_A, "/api/faucet", { address: SAPLING_A, pow: await solvedChallengeFrom(BASE_A, `198.51.100.${runByte}`) });
  ok("A a Sapling drip lands: the app's policy for Sapling covers what the double, like zallet, requires", saplingClaim.status === 200 && saplingClaim.body.ok === true, `${saplingClaim.status} ${JSON.stringify(saplingClaim.body).slice(0, 160)}`);
  // getblockchaininfo carries a branch id only when told to. Wallet A is not told, so
  // the app's chain-identity verdict stays cannot-verify, as it was before the handler
  // existed; the other side of that comparison is the live lightwalletd, and a fixture
  // id would read different-rules against the real network on every run with egress.
  const chainInfo = await rpcRaw(WALLET_A, "getblockchaininfo");
  ok("double: getblockchaininfo answers zebra's shape with NO branch id by default", chainInfo.body?.result?.chain === "test" && chainInfo.body.result.consensus === undefined, JSON.stringify(chainInfo.body));
  const aChain = (await get(BASE_A, "/api/status")).body.node?.chain;
  ok("A and the app's chain-identity verdict is cannot-verify, not a fixture id compared against the live network", aChain?.state === "cannot-verify", JSON.stringify(aChain));
  // BRANCH_ID is a knob for a test that wants the mismatch path, and none does yet:
  // an app in front of a double carrying one would compare it against the live
  // lightwalletd on every status refresh (review of #544, round 2).
  // N: the app with the WRONG password against a wallet that demands one.
  const nStatus = await get(BASE_N, "/api/status");
  ok("N with the wrong wallet credential, the balance reads null: unknown, not zero", nStatus.status === 200 && nStatus.body.balanceTaz === null, JSON.stringify({ balanceTaz: nStatus.body.balanceTaz }));
  const nReady = await get(BASE_N, "/api/ready");
  ok("N and readiness refuses", nReady.status === 503, `status ${nReady.status} ${JSON.stringify(nReady.body.reason ?? "")}`);
  const nAddr = (await post(BASE_N, "/api/account", { type: "shielded" })).body.account?.address ?? "";
  const nClaim = await post(BASE_N, "/api/faucet", { address: nAddr });
  ok("N and a claim is refused BEFORE the send, at the freshness gate: the node's height is unknown through a 401", nClaim.status === 503 && /did not report its height/.test(nClaim.body.error ?? ""), `${nClaim.status} ${JSON.stringify(nClaim.body)}`);
  // P: the 401 lands on z_sendmany itself.
  const pAddr = (await post(BASE_P, "/api/account", { type: "shielded" })).body.account?.address ?? "";
  const pClaim = await post(BASE_P, "/api/faucet", { address: pAddr });
  ok("P a 401 on z_sendmany is a DEFINITE failure: 502, 'nothing left the wallet', never 'on their way'", pClaim.status === 502 && /Nothing left the wallet/.test(pClaim.body.error ?? "") && !/on their way/.test(pClaim.body.error ?? ""), `${pClaim.status} ${JSON.stringify(pClaim.body)}`);
  const pAgain = await post(BASE_P, "/api/faucet", { address: pAddr });
  ok("P and the claim was RELEASED, so the same address may try again at once (the second attempt reaches the wallet again)", pAgain.status === 502, `${pAgain.status} ${JSON.stringify(pAgain.body).slice(0, 120)}`);
  const pSends = (await get(BASE_P, "/api/status")).body.sends;
  ok("P and both count as failed sends, not unresolved ones", pSends && pSends.failed === 2 && pSends.unknown === 0, JSON.stringify(pSends));
  // O: the reply to z_sendmany is lost. Not C's shape (C's wallet returns an opid and
  // the operation hangs): here there is no opid at all, and the app must still hold
  // the claim rather than release it, because the wallet may have broadcast anyway.
  const oAddr = (await post(BASE_O, "/api/account", { type: "shielded" })).body.account?.address ?? "";
  const oClaim = await post(BASE_O, "/api/faucet", { address: oAddr });
  ok("O a z_sendmany reply lost past the RPC timeout is the 504 unknown outcome, not a failure", oClaim.status === 504 && /on their way/.test(oClaim.body.error ?? ""), `${oClaim.status} ${JSON.stringify(oClaim.body)}`);
  const oAgain = await post(BASE_O, "/api/faucet", { address: oAddr });
  // Held for the COOLDOWN, not merely for the pending lease: a row left pending would
  // also answer 429 today and hand out a second drip when the lease ran out (the #51
  // shape). retryAfterSeconds distinguishes the two by a factor of twenty.
  ok("O and the same address is HELD for the full cooldown, not released and not merely leased", oAgain.status === 429 && oAgain.body.kind === "cooldown" && oAgain.body.scope === "address" && oAgain.body.retryAfterSeconds > 80_000, `${oAgain.status} ${JSON.stringify(oAgain.body)}`);
  const oSends = (await get(BASE_O, "/api/status")).body.sends;
  ok("O and it is counted as unresolved, not failed", oSends && oSends.unknown >= 1 && oSends.failed === 0, JSON.stringify(oSends));

  /* ── F: the salt guard is WIRED, not merely correct ───────────────────── */

  // This exists because the proof it replaces was accidental. While the guard ran
  // at config-import time, a failing BUILD is what proved it was connected. Moving
  // it to instrumentation.register() to stop a build needing a production secret
  // removed that proof: saltGuard.test and challengeDefault.test check the
  // PREDICATE, and both smoke suites set RATE_LIMIT_SALT so they boot with one and
  // never take this path. So a refactor could drop the register() call and
  // everything would stay green while production booted unprotected.
  //
  // Raised by SDE-Infra as the #188 shape pointed at the security gate: proving the
  // mechanism while blind to the connection.
  const saltless = await bootExpectingExit(
    PORT_F,
    { FAUCET_SENDER: "zallet", FAUCET_CHALLENGE: "pow", NODE_ENV: "production" },
    `${LOG_DIR}/saltless-boot.log`,
  );
  ok(
    "F a production boot with a gate and NO salt EXITS rather than serving unprotected",
    saltless.code === 1,
    `exit ${saltless.code}${saltless.code === "TIMEOUT" ? " (it stayed up, so the guard is not wired)" : ""}`,
  );
  // And that it died for the RIGHT reason. Without this the check passes on any
  // startup failure at all, which is how a test starts certifying a broken build.
  ok(
    "F and it says which variable, in a boot log an operator reads",
    /fatal config error/.test(saltless.log) && /RATE_LIMIT_SALT is not set/.test(saltless.log),
    JSON.stringify(saltless.log.split("\n").filter(Boolean).slice(-2)),
  );
} finally {
  stop(fakeHosh);
  stop(fakeHoshStale);
  stop(fakeHoshEmpty);
  stop(serverD);
  stop(walletD);
  stop(serverE);
  stop(walletE);
  stop(serverH);
  stop(walletH);
  stop(serverI);
  stop(walletI);
  stop(serverJ);
  stop(walletJ);
  stop(serverR);
  stop(serverS);
  stop(serverT);
  stop(walletS);
  stop(walletT);
  stop(walletR);
  stop(serverK);
  try { serverL.kill("SIGKILL"); } catch { /* already gone */ }
  stop(walletL);
  try { serverM.kill("SIGKILL"); } catch { /* already gone */ }
  stop(walletM);
  stop(walletK);
  stop(serverN);
  stop(walletN);
  stop(serverO);
  stop(walletO);
  stop(serverP);
  stop(walletP);
  if (serverQ) stop(serverQ);
  stop(serverA);
  stop(serverB);
  stop(serverC);
  stop(walletA);
  stop(walletB);
  stop(walletC);
}

// ITEM 3, THE RUNTIME HALF: every refusal this run produced carries a gate on the info line.
// The unit rows prove the MECHANISM and count the SITES in the source; this reads what the
// servers actually wrote across every refusal path the suite drove, and fails on the first
// non-200 claim that landed with gate null. That is the row that stops a nineteenth site
// shipping half-wired: tsc catches a missing argument, this catches a site whose gate never
// reached the line.
{
  const logs = readdirSync(LOG_DIR).filter((f) => /^server-\d+\.log$/.test(f));
  const seen = new Map();           // gate -> count
  let refusals = 0, unnamed = 0;
  for (const f of logs) {
    for (const line of readFileSync(join(LOG_DIR, f), "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.level !== "info" || j.path !== "/api/faucet" || j.status === 200) continue;
      refusals++;
      if (j.gate == null) unnamed++; else seen.set(j.gate, (seen.get(j.gate) ?? 0) + 1);
    }
  }
  ok("item 3: every non-200 claim this run produced carries a gate on its info line",
     refusals > 0 && unnamed === 0,
     `${refusals} refusals, ${unnamed} with gate null, gates seen: ${[...seen.keys()].sort().join(" ")}`);
  // A POSITIVE CONTROL on the reader itself: a run that drove the freshness gate and the send
  // failure must show both, or the row above is counting lines it cannot see.
  // walletLag is driven by T alone; until T existed no test emitted that gate at all.
  ok("item 3: and the reader saw the gates this suite is known to drive",
     seen.has("freshness") && seen.has("sendFailed") && seen.has("cooldown") && seen.has("walletLag"),
     `freshness=${seen.get("freshness") ?? 0} sendFailed=${seen.get("sendFailed") ?? 0} cooldown=${seen.get("cooldown") ?? 0} walletLag=${seen.get("walletLag") ?? 0}`);
}

console.log(failures === 0 ? "\napi-integration: all green" : `\napi-integration: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
