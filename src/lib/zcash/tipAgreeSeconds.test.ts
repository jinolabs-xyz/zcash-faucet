/**
 * TIP_AGREE_SECONDS is parsed by the repo's env parser, not by bare Number().
 *
 * The same guard tipAgreeBlocks.test.ts exists for, moved to the constant that now DECIDES.
 * Number("") is 0, which makes `corroborated` false for any spread at all, and Number("abc")
 * is NaN, where `spread <= NaN` is false, so corroboration would be false permanently. Either
 * reaches the watchdog's fork rung as "the references disagree" - page, heal nothing - for
 * ever, with nothing saying why. The empty spelling is live here because CI and the suites set
 * variables to empty on purpose.
 *
 * Review found the old file still guarding TIP_AGREE_BLOCKS, which after #600 step 2 only
 * decides the fallback path, so the check that mattered had quietly stopped covering it.
 *
 * Its own file: config reads the environment once, at module load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// NO REAL ORACLE FROM A UNIT TEST. Both legs: HOSH_URL to a closed port seals the aggregate,
// TIP_ORACLE_ENDPOINT set EMPTY seals the direct gRPC leg, which defaults to testnet.zec.rocks
// when merely unset (config.ts:140). Before any import that loads config. Enforced by
// zcash/oraclePin.test.ts.
process.env.HOSH_URL = "http://127.0.0.1:9/";
process.env.TIP_ORACLE_ENDPOINT = "";
// The THIRD leg: chainIdentityOracle dials LIGHTWALLETD_ENDPOINT directly (config.ts:116).
process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:9";

process.env.TIP_AGREE_SECONDS = "";
const { AGREE_SECONDS } = await import("./externalTip.ts");
const { num } = await import("../config.ts");

test("an EMPTY setting falls back to the shipped tolerance rather than collapsing it to zero", () => {
  assert.equal(AGREE_SECONDS, 300, "Number('') would be 0, and every spread above zero would read as disagreement");
});

test("and a value that is not a number refuses to boot rather than disabling the check", () => {
  process.env.TIP_AGREE_SECONDS = "abc";
  assert.throws(() => num("TIP_AGREE_SECONDS", 300), /must be a number/);
});
