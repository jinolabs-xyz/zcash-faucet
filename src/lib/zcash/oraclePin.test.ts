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
 * Two things follow, and each is a half of this row:
 *   1. BOTH legs need sealing. HOSH_URL seals the aggregate. The direct leg is sealed either by
 *      TIP_ORACLE_ENDPOINT set explicitly, or by LIGHTWALLETD_ENDPOINT pinned to a closed port
 *      with TIP_ORACLE_ENDPOINT left unset, because unset inherits it (config.ts:140). Per L62 a
 *      fetch stub seals nothing here because the direct leg is not fetch.
 *   2. The pin must precede the import, and a STATIC import is hoisted above every env line in
 *      the file, so it cannot be pinned at all. Dynamic only.
 *
 * Static over the source, like the gate-field count row: the source is ours and does not reword
 * itself, and the row names the file so the fix is one screen away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Modules whose import loads the oracle config, and whose use can kick the dial. */
const REACHES_ORACLE = /(?:^|\/)(nodeStatus|nodeStatusCache|externalTip|shieldGate|forkReference)\.ts"/;

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
    // REACH IS THE FIRST MENTION OF THE MODULE, however it gets there. A top-level import, an
    // `await import()`, or a path inside a script handed to a spawned child that inherits
    // process.env (shieldGateEnv.test.ts) all load the oracle config; the first version of this
    // row saw only the first two and missed the third.
    const mention = src.match(REACHES_ORACLE);
    if (!mention) continue;
    const staticImport = src.match(new RegExp(`^import[^\\n]*${REACHES_ORACLE.source}`, "m"));
    if (staticImport) {
      offenders.push(`${rel}: STATIC import of ${staticImport[1]}.ts is hoisted above any pin - use await import()`);
      continue;
    }
    const before = src.slice(0, mention.index!);
    const hosh = /process\.env\.HOSH_URL\s*=/.test(before);
    // TWO SPELLINGS SEAL THE DIRECT LEG, and the first version of this row accepted only one.
    // TIP_ORACLE_ENDPOINT set (empty or loopback) is the explicit seal. TIP_ORACLE_ENDPOINT left
    // unset INHERITS LIGHTWALLETD_ENDPOINT (config.ts:117-121, 140), so pinning that to a closed
    // port seals it too - five tests were already sealed that way and the row called them exposed.
    const direct = /process\.env\.(TIP_ORACLE_ENDPOINT|LIGHTWALLETD_ENDPOINT)\s*=/.test(before);
    if (!hosh || !direct) {
      const missing = [!hosh && "HOSH_URL", !direct && "TIP_ORACLE_ENDPOINT (or LIGHTWALLETD_ENDPOINT)"].filter(Boolean).join(" and ");
      offenders.push(`${rel}: reaches ${mention[1]}.ts without pinning ${missing} first`);
    }
  }
  assert.deepEqual(offenders, [], `tests that can reach the real testnet:\n  ${offenders.join("\n  ")}`);
});

test("and the row is not vacuous: it can see the tests it is meant to guard", () => {
  // A positive control. If the walk or the pattern silently matched nothing, the row above
  // would pass with an empty offenders list for the wrong reason.
  const reaching = tests.filter((f) => REACHES_ORACLE.test(readFileSync(f, "utf8").replace(/\n/g, " ")) && !f.endsWith("oraclePin.test.ts"));
  assert.ok(reaching.length >= 10, `expected at least the 13 oracle-reaching tests measured on 2026-09-21, saw ${reaching.length}`);
});
