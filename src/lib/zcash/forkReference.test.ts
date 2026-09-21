/**
 * THE WATCHDOG PARSES THIS WITH A SHELL GREP, so its SHAPE is part of the contract, not just its
 * values. `watchdog.sh` isolates the object with `grep -o '"forkReference":{[^}]*}'`, which is
 * correct only while every field is a scalar: one nested object and `[^}]*` stops at the inner
 * brace, the hash falls outside the match, and the fork rung goes permanently dark with a single
 * log line.
 *
 * That is not hypothetical. The rung had never once run before #714 because the stub encoded a
 * flat pair the app never shipped, and nothing on either side asserted the shape. This row is the
 * app half of that contract: the producer cannot break the consumer without a red test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// NO REAL ORACLE FROM A UNIT TEST, three legs. HOSH_URL seals the aggregate; LIGHTWALLETD_ENDPOINT
// seals the read-side leg the chain-identity oracle dials directly (config.ts:116, real by default)
// and, left unset, the direct tip leg inherits it (config.ts:140). All before any import that loads
// config. Enforced by zcash/oraclePin.test.ts.
process.env.HOSH_URL = "http://127.0.0.1:9/";
process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:9";
process.env.TIP_ORACLE_ENDPOINT = "";
const { readForkReference, resetForkReference } = await import("./forkReference.ts");
type ForkReference = import("./forkReference.ts").ForkReference;

const serialised = (r: ForkReference) => JSON.stringify({ forkReference: r });

test("#714: every field of forkReference is a scalar, because a shell grep reads it", () => {
  resetForkReference();
  const r = readForkReference(Date.now());
  for (const [k, v] of Object.entries(r)) {
    assert.ok(
      v === null || typeof v === "number" || typeof v === "string",
      `forkReference.${k} is ${typeof v}; the watchdog's [^}]* isolation only survives scalars`,
    );
  }
});

test("#714: the serialised object contains no nested brace, which is what the grep depends on", () => {
  resetForkReference();
  const body = serialised(readForkReference(Date.now()));
  // Exactly what watchdog.sh does, in the same shape, so this fails the way the rung would.
  const isolated = body.match(/"forkReference":\{[^}]*\}/);
  assert.ok(isolated, "the isolation pattern must match at all");
  // The isolated text must be the WHOLE object: re-parsing it has to round-trip every key.
  const reparsed = JSON.parse(`{${isolated[0]}}`) as { forkReference: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(reparsed.forkReference).sort(),
    Object.keys(readForkReference(Date.now())).sort(),
    "the grep captured a TRUNCATED object - a field was added that the watchdog cannot see",
  );
});

test("#714: a nested field would break the isolation, which is why the row above exists", () => {
  // The mutant, written as a row rather than left to a reviewer: this is what adding
  // `source: { name, url }` does to the consumer.
  const withNested = { ...readForkReference(Date.now()), source: { name: "hosh" } } as unknown as ForkReference;
  const isolated = serialised(withNested).match(/"forkReference":\{[^}]*\}/);
  assert.ok(isolated, "still matches something");
  assert.throws(
    () => JSON.parse(`{${isolated[0]}}`),
    "a nested object truncates the match into invalid JSON - the rung sees no hash and goes dark",
  );
});
