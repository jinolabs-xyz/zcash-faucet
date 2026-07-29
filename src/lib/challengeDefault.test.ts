/**
 * The anti-abuse gate's DEFAULT, which is the whole security property here.
 *
 * config.ts is a module-level singleton that reads env once at import, so each
 * case gets its own child process with its own environment. That is heavier than
 * a pure function test and it is the only way to assert what an operator who sets
 * nothing actually gets, which is the thing that was wrong: the default was off,
 * so a fresh box, a clean redeploy or a forgotten variable all came up serving
 * with no gate and said nothing about it.
 *
 * Asserting through the real config rather than re-deriving the ternary, because
 * a copy of the rule would pass while the shipped default went back to none.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/** Boot config.ts in a child with `env` and return its resolved challenge, or THREW:<msg>. */
function challengeUnder(env: Record<string, string>, mode: "challenge" | "serving" = "challenge"): string {
  // "challenge" reports the resolved gate. "serving" reports what the BOOT guard
  // does, which is a different question and the one that decides whether an
  // artifact can be built without a production secret.
  const call =
    mode === "serving"
      ? '(m) => { m.assertServingConfig(); console.log("OK"); }'
      : '(m) => console.log(m.config.challenge)';
  const script =
    'import("./src/lib/config.ts")' +
    `.then(${call})` +
    '.catch((e) => console.log("THREW:" + e.message));';
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    // A clean slate: inheriting the parent's env would let an ambient
    // FAUCET_CHALLENGE decide the result and the test would pass by accident.
    //
    // Cast because this project's ProcessEnv declares NODE_ENV as required, and
    // the whole point here is to hand over an env that has only what we chose.
    env: { PATH: process.env.PATH ?? "", FAUCET_SENDER: "zallet", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

test("an operator who sets NOTHING gets the gate, not an open faucet", () => {
  // The regression this file exists for. Before, this was "none".
  assert.equal(challengeUnder({}), "pow");
});

test("turning the gate off has to be asked for by name", () => {
  assert.equal(challengeUnder({ FAUCET_CHALLENGE: "none" }), "none");
});

test("an explicit choice still wins over the default", () => {
  assert.equal(challengeUnder({ FAUCET_CHALLENGE: "turnstile" }), "turnstile");
  assert.equal(challengeUnder({ FAUCET_CHALLENGE: "pow" }), "pow");
});

test("a configured Turnstile secret still selects turnstile", () => {
  // The old fallback's useful half, kept: someone who wired Turnstile and never
  // set FAUCET_CHALLENGE should not be silently switched to pow.
  assert.equal(challengeUnder({ TURNSTILE_SECRET_KEY: "a-real-secret" }), "turnstile");
});

test("IMPORTING config in production does NOT throw, which is what lets a build work", () => {
  // The regression that took CI red. `next build` sets NODE_ENV=production and
  // imports every route module to collect page data, so a guard at import time made
  // compiling the artifact require the production secret. Move the check back to
  // import time and this fails, before CI has to tell you.
  assert.equal(challengeUnder({ NODE_ENV: "production" }), "pow");
  assert.equal(challengeUnder({ NODE_ENV: "production", RATE_LIMIT_SALT: "__FILL_ME__" }), "pow");
});

test("but SERVING in production with a placeholder salt refuses", () => {
  // The security property, unmoved: it just fires at boot now, where an operator
  // reads it, instead of in build output (#206).
  const out = challengeUnder({ NODE_ENV: "production", RATE_LIMIT_SALT: "__FILL_ME__" }, "serving");
  assert.match(out, /^THREW:/);
  assert.match(out, /placeholder/);
});

test("and serving with NO salt refuses too", () => {
  const out = challengeUnder({ NODE_ENV: "production" }, "serving");
  assert.match(out, /^THREW:/);
  assert.match(out, /RATE_LIMIT_SALT is not set/);
});

test("serving in production with a real salt is fine", () => {
  const out = challengeUnder(
    { NODE_ENV: "production", RATE_LIMIT_SALT: "b1946ac92492d2347c6235b4d2611184e0f4a3a5c9e01f8a2b3c4d5e6f708192" },
    "serving",
  );
  assert.equal(out, "OK");
});

test("challenge=none needs no salt even when serving, so local work is unaffected", () => {
  // saltGuard only guards an ACTIVE gate. If this starts throwing, the guard has
  // widened and every test double that runs saltless breaks with it.
  assert.equal(challengeUnder({ NODE_ENV: "production", FAUCET_CHALLENGE: "none" }, "serving"), "OK");
});
