/**
 * NO UNIT TEST MAY REACH THE REAL TIP ORACLE, and this row is what makes that a property of the
 * suite rather than a habit of its authors.
 *
 * Reading the oracle kicks a background refresh whose direct leg dials config.tipOracleEndpoints
 * over gRPC - and that list defaults to testnet.zec.rocks:443 when TIP_ORACLE_ENDPOINT is
 * UNSET (config.ts:140). Only an explicit empty string disables it. #715's row failed on CI and
 * passed on every laptop because the dial landed inside the file's first second on a fast runner
 * and after its last row on a slow one: the same test, decided by runner speed.
 *
 * Three things follow, and each is a row here:
 *   1. THREE LEGS, sealed by two pins. HOSH_URL seals the aggregate. LIGHTWALLETD_ENDPOINT seals
 *      the read-side leg the chain-identity oracle dials directly (config.ts:116) AND, left
 *      unset, the direct tip leg inherits it (config.ts:140). TIP_ORACLE_ENDPOINT="" is then a
 *      belt over braces. Per L62 a fetch stub seals nothing here: none of the three is fetch.
 *   2. The pin must precede the import, and a STATIC value import is hoisted above every env
 *      line in the file, so it cannot be pinned at all. Dynamic only. `import type` is erased
 *      and loads nothing, so it is not an import for this purpose.
 *   3. THE LIST OF REACHING MODULES IS CLOSED UNDER IMPORT. expiryTip.ts and zalletRefiller.ts
 *      value-import the oracle modules and were not on the first list (SDE-UI, #725), so a test
 *      importing either reached the oracle unseen. The closure row walks every module under
 *      src/ and refuses any that imports a listed module without being listed itself.
 *
 * Static over the source, like the gate-field count row: the source is ours and does not reword
 * itself, and the row names the file so the fix is one screen away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every module whose import loads the oracle config, relative to src/. Closed under import by
 * the row below: add a module that imports one of these and the row names it until it is here.
 * Fifteen, not five: the first list was the modules that dial, and the closure ran three rounds
 * deeper (refiller, realsend, t2zsend; then reconciler; then the donate page) before it was
 * quiet. A test importing any of them loads config with the oracle list in it.
 */
const REACHING = [
  "app/api/faucet/route.ts",
  "app/api/ready/route.ts",
  "app/api/status/route.ts",
  "app/donate/page.tsx",
  "lib/reserve/reconciler.ts",
  "lib/reserve/refiller.ts",
  "lib/reserve/zalletRefiller.ts",
  "lib/zcash/expiryTip.ts",
  "lib/zcash/externalTip.ts",
  "lib/zcash/forkReference.ts",
  "lib/zcash/nodeStatus.ts",
  "lib/zcash/nodeStatusCache.ts",
  "lib/zcash/realsend.ts",
  "lib/zcash/shieldGate.ts",
  "lib/zcash/t2zsend.ts",
] as const;
/**
 * Resolve every path-like string in a file to a src-relative module and report the first one
 * that is in REACHING. Real resolution rather than a regex over the text: a bare basename
 * matched the home page against the donate page, and a dir/name tail missed `./x.ts` in the
 * same directory - both found by the positive control below. Handles `./`, `../`, the `@/`
 * alias, and the `./src/...` form a spawned child script uses (shieldGateEnv.test.ts).
 */
function firstReach(file: string, src: string): { index: number; module: string } | null {
  const listed = new Set<string>(REACHING);
  let best: { index: number; module: string } | null = null;
  for (const m of src.matchAll(/"((?:\.\.?\/|@\/)[^"\n]+?)"/g)) {
    const spec = m[1];
    // `import type` is erased at compile time and loads nothing. The resolver saw the path in
    // such a line and called it a reach (SDE-UI, #725; the M7 mutant reproduced it).
    const lineStart = src.lastIndexOf("\n", m.index!) + 1;
    if (/^\s*import\s+type\b/.test(src.slice(lineStart, m.index!))) continue;
    let target: string;
    if (spec.startsWith("@/")) target = spec.slice(2);
    else if (spec.startsWith("./src/")) target = spec.slice("./src/".length);
    else target = relative(SRC, resolve(dirname(file), spec));
    for (const cand of [target, target + ".ts", target + ".tsx"]) {
      if (listed.has(cand) && (best === null || m.index! < best.index)) best = { index: m.index!, module: cand };
    }
  }
  return best;
}

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const tests: string[] = [];
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".test.ts")) tests.push(p);
  }
};
walk(SRC);

test("every test that imports an oracle-reaching module pins BOTH legs before a DYNAMIC import", () => {
  const offenders: string[] = [];
  for (const file of tests) {
    if (file.endsWith("oraclePin.test.ts")) continue;
    const src = readFileSync(file, "utf8");
    const rel = file.slice(SRC.length);
    // REACH IS THE FIRST RESOLVED MENTION OF A LISTED MODULE, however it gets there: a top-level
    // import, an `await import()`, or a path inside a script handed to a spawned child that
    // inherits process.env (shieldGateEnv.test.ts).
    const mention = firstReach(file, src);
    if (!mention) continue;
    const staticImport = src.match(/^import(?!\s+type\b)[^\n]*from\s+"([^"]+)"/gm)?.find((line) => {
      const spec = line.match(/"([^"]+)"$/)?.[1] ?? "";
      const t = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? relative(SRC, resolve(dirname(file), spec)) : "";
      return [t, t + ".ts", t + ".tsx"].some((c) => (REACHING as readonly string[]).includes(c));
    });
    if (staticImport) {
      offenders.push(`${rel}: STATIC import (${staticImport.match(/"([^"]+)"$/)?.[1]}) is hoisted above any pin - use await import()`);
      continue;
    }
    const before = src.slice(0, mention.index!);
    const hosh = /process\.env\.HOSH_URL\s*=/.test(before);
    // THREE LEGS, TWO PINS. LIGHTWALLETD_ENDPOINT is REQUIRED, not an alternative: the chain
    // identity oracle dials config.lightwalletdEndpoints directly (config.ts:116, real by default)
    // and neither of the other two variables touches it. The second version of this row treated
    // it as an alternate seal for the direct tip leg - which it also is, because an unset
    // TIP_ORACLE_ENDPOINT inherits it (config.ts:140) - and the CTO's red-team measured a pinned
    // test still dialling testnet.zec.rocks through the leg this row was not asking about.
    const lwd = /process\.env\.LIGHTWALLETD_ENDPOINT\s*=/.test(before);
    if (!hosh || !lwd) {
      const missing = [!hosh && "HOSH_URL", !lwd && "LIGHTWALLETD_ENDPOINT"].filter(Boolean).join(" and ");
      offenders.push(`${rel}: reaches ${mention.module} without pinning ${missing} first`);
    }
  }
  assert.deepEqual(offenders, [], `tests that can reach the real testnet:\n  ${offenders.join("\n  ")}`);
});

test("and the row is not vacuous: it can see the tests it is meant to guard", () => {
  // A positive control. If the resolver silently matched nothing, the row above would pass with
  // an empty offenders list for the wrong reason. It has, twice, during review.
  const reaching = tests.filter((f) => !f.endsWith("oraclePin.test.ts") && firstReach(f, readFileSync(f, "utf8")) !== null);
  assert.ok(reaching.length >= 15, `expected at least the 15 reaching tests measured on 2026-09-21, saw ${reaching.length}: ${reaching.map((f) => relative(SRC, f)).join(", ")}`);
});

test("the reaching list is closed under import: a module that imports a listed one is listed", () => {
  // Without this the list is a snapshot that goes stale the day someone adds a helper over
  // externalTip.ts - which had already happened twice (expiryTip, zalletRefiller) when UI read
  // #725. Value imports only; a type import loads nothing. Relative paths and the @/ alias both.
  const mods: string[] = [];
  const walkAll = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkAll(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) mods.push(p);
    }
  };
  walkAll(SRC);
  const listed = new Set<string>(REACHING);
  const unlisted: string[] = [];
  for (const file of mods) {
    const rel = relative(SRC, file);
    if (listed.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^import(?!\s+type\b)[^\n]*from\s+"([^"]+)"/gm)) {
      const spec = m[1];
      let target: string;
      if (spec.startsWith("@/")) target = spec.slice(2) + (spec.endsWith(".ts") ? "" : ".ts");
      else if (spec.startsWith(".")) target = relative(SRC, resolve(dirname(file), spec));
      else continue;                                   // a package, not ours
      if (listed.has(target)) { unlisted.push(`${rel} imports ${target}`); break; }
    }
  }
  assert.deepEqual(unlisted, [], `modules that reach the oracle and are not in REACHING:\n  ${unlisted.join("\n  ")}`);
});

/**
 * THE INSTRUMENT, not the rule. Everything above reads source; this DIALS. A child process is
 * started with a preload that patches dns.lookup, net.connect and tls.connect to record every
 * destination that is not loopback, imports the oracle modules the way a test would, takes one
 * page read, and reports what tried to leave the machine. With the three pins: nothing. Without
 * them, the positive control: at least one dial to a real host, or the instrument is blind and
 * the zero above means nothing. This is the measurement the CTO's red-team ran to find the third
 * leg, and it is what the rows above should have carried from the start (L45).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const PRELOAD = `
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
const seen = new Set();
const loopback = (h) => !h || h === "localhost" || /^127\\./.test(h) || h === "::1";
const note = (h) => { if (!loopback(String(h))) seen.add(String(h)); };
const wrapLookup = (fn) => function (host, ...rest) { note(host); return fn.call(this, host, ...rest); };
dns.lookup = wrapLookup(dns.lookup);
if (dns.promises?.lookup) dns.promises.lookup = wrapLookup(dns.promises.lookup);
const wrapConnect = (mod, name) => { const orig = mod[name]; mod[name] = function (...a) {
  const o = typeof a[0] === "object" && a[0] ? a[0] : {}; note(o.host ?? o.hostname ?? (typeof a[1] === "string" ? a[1] : "")); return orig.apply(this, a); }; };
wrapConnect(net, "connect"); wrapConnect(net, "createConnection"); wrapConnect(tls, "connect");
process.on("exit", () => { process.stdout.write("DIALS " + JSON.stringify([...seen]) + "\\n"); });
`;

/** Where each leg is aimed for one probe: the loopback pins, or one sentinel name per leg. */
type Aim = { HOSH_URL: string; LIGHTWALLETD_ENDPOINT: string; TIP_ORACLE_ENDPOINT: string };
const PINNED: Aim = { HOSH_URL: "http://127.0.0.1:9/", LIGHTWALLETD_ENDPOINT: "https://127.0.0.1:9", TIP_ORACLE_ENDPOINT: "" };
// .invalid never resolves (RFC 2606), so the control proves each leg is SEEN without a packet
// leaving beyond the resolver. Aiming the control at the real defaults would make this suite
// reach zec.rocks from CI, which is the thing the rows above exist to stop.
const SENTINEL: Aim = { HOSH_URL: "https://hosh-leg.invalid/", LIGHTWALLETD_ENDPOINT: "https://lwd-leg.invalid:443", TIP_ORACLE_ENDPOINT: "https://tip-leg.invalid:443" };

function dialsWith(aim: Aim): string[] {
  const dir = mkdtempSync(join(tmpdir(), "oracle-dial-"));
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, PRELOAD);
  const tip = JSON.stringify(join(SRC, "lib/zcash/externalTip.ts"));
  const ident = JSON.stringify(join(SRC, "lib/zcash/chainIdentityOracle.ts"));
  // KICK EACH LEG BY NAME rather than through getNodeStatus: a page read consults the oracle
  // only after the wallet answers, and with no wallet it never gets there - the first version of
  // this control read DIALS [] unpinned and would have called a blind instrument sighted. The
  // budget is the real shape: a bare number made AbortSignal.timeout(undefined) throw inside
  // fetchBothReferencesWithin's catch, and the hosh leg was silently never fetched.
  const script = `
    process.env.DB_BACKEND = "sqlite";
    const tip = await import(${tip});
    const ident = await import(${ident});
    try { await tip.fetchBothReferencesWithin({ hoshTimeoutMs: 1500, fallbackTotalMs: 1500 }); } catch {}  // hosh + direct
    try { await ident.warmChainIdentity(); } catch {}                                                  // read-side, the third leg
    await new Promise((r) => setTimeout(r, 800));
  `;
  let out = "";
  try {
    out = execFileSync(process.execPath, ["--import", preload, "--input-type=module", "--eval", script],
      // cwd is the REPO ROOT: grpc.ts loads proto/service.proto relative to it (grpc.ts:15).
      { cwd: resolve(SRC, ".."), env: { ...process.env, ...aim, ZALLET_RPC_URL: "http://127.0.0.1:9/", FAUCET_SENDER: "zallet", DATA_DIR: dir },
        encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    throw new Error(`dial probe exited ${err.status}: ${(err.stderr ?? "").split("\n").filter((l) => !/Warning|Reparsing|eliminate this warning|^\s*$/.test(l)).slice(-12).join(" | ")}`);
  }
  const line = out.split("\n").find((l) => l.startsWith("DIALS "));
  return line ? (JSON.parse(line.slice(6)) as string[]) : [];
}

test("MEASURED: with the three pins, the oracle legs dial nothing off the machine", () => {
  const dials = dialsWith(PINNED);
  assert.deepEqual(dials, [], `hosts a pinned test still tried to reach: ${dials.join(", ")}`);
});

test("MEASURED, positive control: aimed at a sentinel per leg, the instrument sees all three - so the zero above is a zero", () => {
  const dials = dialsWith(SENTINEL);
  const unseen = (["HOSH_URL", "LIGHTWALLETD_ENDPOINT", "TIP_ORACLE_ENDPOINT"] as const)
    .filter((leg) => !dials.some((h) => SENTINEL[leg].includes(h)));
  assert.deepEqual(unseen, [], `legs the instrument is blind to: ${unseen.join(", ")} (saw: ${dials.join(", ") || "nothing"})`);
});
