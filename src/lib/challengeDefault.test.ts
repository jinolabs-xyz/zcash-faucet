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
function challengeUnder(env: Record<string, string>): string {
  const script =
    'import("./src/lib/config.ts")' +
    '.then((m) => console.log(m.config.challenge))' +
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

test("production with a gate and a placeholder salt REFUSES TO BOOT", () => {
  // The trade this default makes. A fresh box gets a message naming what to set
  // instead of coming up unprotected, because a known salt is a forgeable gate.
  const out = challengeUnder({ NODE_ENV: "production", RATE_LIMIT_SALT: "__FILL_ME__" });
  assert.match(out, /^THREW:/);
  assert.match(out, /placeholder/);
});

test("production with a gate and NO salt refuses too", () => {
  const out = challengeUnder({ NODE_ENV: "production" });
  assert.match(out, /^THREW:/);
  assert.match(out, /RATE_LIMIT_SALT is not set/);
});

test("production with a real salt boots with the gate on", () => {
  const out = challengeUnder({
    NODE_ENV: "production",
    RATE_LIMIT_SALT: "b1946ac92492d2347c6235b4d2611184e0f4a3a5c9e01f8a2b3c4d5e6f708192",
  });
  assert.equal(out, "pow");
});

test("challenge=none in production still needs no salt, so local work is unaffected", () => {
  // saltGuard only guards an ACTIVE gate. If this ever starts throwing, the
  // guard has widened and every test double that runs saltless breaks with it.
  assert.equal(challengeUnder({ NODE_ENV: "production", FAUCET_CHALLENGE: "none" }), "none");
});
