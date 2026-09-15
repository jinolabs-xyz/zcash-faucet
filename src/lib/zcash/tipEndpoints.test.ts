/**
 * The tip oracle's endpoint list is its own, and defaults to the read-side one.
 *
 * One variable used to answer two questions: where the app reads balances, and which
 * third party may serve as an independent view of the chain. They are different roles -
 * an operator's own Zaino is a fine backend and is never independent of their own node -
 * and once both references are fetched every refresh, a test that wants the oracle quiet
 * could not have it without also breaking the backend ping.
 *
 * Its own file because config reads the environment once, at module load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LIGHTWALLETD_ENDPOINT = "https://backend.example:443";
process.env.TIP_ORACLE_ENDPOINT = "https://oracle.example:443, https://second.example:443";
const { config } = await import("../config.ts");

test("the oracle looks where TIP_ORACLE_ENDPOINT says, not at the read-side backend", () => {
  assert.deepEqual(config.tipOracleEndpoints, ["https://oracle.example:443", "https://second.example:443"]);
  assert.deepEqual(config.lightwalletdEndpoints, ["https://backend.example:443"], "the backend is untouched");
});

test("an explicitly empty list means the aggregate alone, and is not the default", () => {
  // THIS RE-IMPLEMENTS THE PARSER, and the comment here used to claim the opposite -
  // SDE-Infra's note on review. What it can honestly show is the DISTINCTION the split
  // rests on: "" and unset are different answers, which is what lets a suite stand the
  // direct leg down without breaking the backend ping. The unset branch against the real
  // module is covered where a test imports config with the variable absent
  // (externalTip.test.ts), not here.
  const parse = (raw: string | undefined) =>
    raw === undefined
      ? config.lightwalletdEndpoints
      : raw.split(",").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(parse(""), [], "set to empty: no direct reference at all");
  assert.deepEqual(parse(undefined), config.lightwalletdEndpoints, "unset: exactly today's behaviour");
});
