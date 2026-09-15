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

test("an explicitly EMPTY list means the aggregate alone, read from config rather than from a copy of its parser", async () => {
  // AGAINST THE REAL MODULE. The first version of this case re-implemented the parser in a
  // local closure and asserted that - which would have stayed green if config had started
  // treating "" as unset, the exact confusion the split exists to avoid (the CTO's
  // red-team, and SDE-Infra's note that the comment claimed otherwise). config reads the
  // environment once at load, so a fresh evaluation is the only way to ask it a second
  // question: the query string defeats the module cache.
  process.env.TIP_ORACLE_ENDPOINT = "";
  // The specifier is widened to `string` on purpose: tsc cannot resolve a query-string
  // module and would fail the build, while node needs exactly that query to re-evaluate.
  const spec: string = "../config.ts?empty-tip-oracle";
  const fresh = (await import(spec)) as typeof import("../config.ts");
  assert.deepEqual(fresh.config.tipOracleEndpoints, [], "empty is a real answer: no direct reference at all");
  assert.deepEqual(
    fresh.config.lightwalletdEndpoints,
    ["https://backend.example:443"],
    "and it did not take the backend list as a fallback, which is what unset does",
  );
});
