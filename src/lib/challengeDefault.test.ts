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
import { spawnSync } from "node:child_process";

/** Boot config.ts in a child with `env` and return its resolved challenge, or THREW:<msg>. */
function challengeUnder(env: Record<string, string>, mode: "challenge" | "serving" | "serving-stderr" = "challenge"): string {
  // "challenge" reports the resolved gate. "serving" reports what the BOOT guard
  // does, which is a different question and the one that decides whether an
  // artifact can be built without a production secret.
  const call =
    mode === "serving" || mode === "serving-stderr"
      ? '(m) => { m.assertServingConfig(); console.log("OK"); }'
      : '(m) => console.log(m.config.challenge)';
  const script =
    'import("./src/lib/config.ts")' +
    `.then(${call})` +
    '.catch((e) => console.log("THREW:" + e.message));';
  // A clean slate: inheriting the parent's env would let an ambient
  // FAUCET_CHALLENGE decide the result and the test would pass by accident.
  //
  // Cast because this project's ProcessEnv declares NODE_ENV as required, and
  // the whole point here is to hand over an env that has only what we chose.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH ?? "", FAUCET_SENDER: "zallet", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  // "serving-stderr" returns what the boot WARNED instead: the warnings are the only
  // notice an operator gets, and a test of them has to read where they go.
  return (mode === "serving-stderr" ? child.stderr : child.stdout).trim();
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

test("a value that is not one of the three REFUSES TO BOOT, naming what it got", () => {
  // The regression class: `Pow`, `captcha`, `turnstyle` used to cast straight through,
  // compare equal to neither branch in the claim route, and the gate was simply absent.
  for (const bad of ["Pow", "captcha", "turnstyle", "POW", "off"]) {
    const out = challengeUnder({ FAUCET_CHALLENGE: bad });
    assert.match(out, /^THREW:FAUCET_CHALLENGE must be pow or none, got/, bad);
    assert.match(out, new RegExp(`got "${bad}"`), bad);
  }
});

test("an EMPTY value is unset, not a fourth state that disables the gate", () => {
  // `FAUCET_CHALLENGE=` in an env file used to cast "" through and turn the gate off.
  assert.equal(challengeUnder({ FAUCET_CHALLENGE: "" }), "pow");
  assert.equal(challengeUnder({ FAUCET_CHALLENGE: "   " }), "pow");
  assert.equal(challengeUnder({ FAUCET_CHALLENGE: " none " }), "none");
});

test("A TURNSTILE SECRET ALONE CHANGES NOTHING: the default is pow, full stop", () => {
  // The Render trap: DEPLOY.md told an operator to set both Turnstile keys, render.yaml
  // set no FAUCET_CHALLENGE, and the secret alone flipped the gate to a mode the page
  // cannot serve, so every claim was a 403. The key is inert now.
  assert.equal(challengeUnder({ TURNSTILE_SECRET_KEY: "a-real-secret" }), "pow");
  assert.equal(challengeUnder({ TURNSTILE_SECRET_KEY: "   " }), "pow");
  assert.equal(challengeUnder({ TURNSTILE_SECRET_KEY: "a-real-secret", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site" }), "pow");
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

test("SERVING turnstile REFUSES TO BOOT, with or without a secret: the page cannot serve the mode", () => {
  // Verified live before this: turnstile plus a secret, the exact body page.tsx builds,
  // HTTP 403 on every claim. A faucet that refuses everyone must not start quietly.
  const envs: Record<string, string>[] = [
    { FAUCET_CHALLENGE: "turnstile" },
    { FAUCET_CHALLENGE: "turnstile", TURNSTILE_SECRET_KEY: "sk" },
    { NODE_ENV: "production", FAUCET_CHALLENGE: "turnstile", TURNSTILE_SECRET_KEY: "sk", RATE_LIMIT_SALT: "b1946ac92492d2347c6235b4d2611184e0f4a3a5c9e01f8a2b3c4d5e6f708192" },
  ];
  for (const env of envs) {
    const out = challengeUnder(env, "serving");
    assert.match(out, /^THREW:/, JSON.stringify(env));
    assert.match(out, /not a mode this faucet can serve/, JSON.stringify(env));
    assert.match(out, /renders no Turnstile widget/, JSON.stringify(env));
    assert.doesNotMatch(out, /for the day a client half exists/, "no promise of a client half");
  }
});

test("but the word still PARSES, so `next build` cannot be broken by it: the refusal is at serving, where traffic starts", () => {
  assert.equal(challengeUnder({ FAUCET_CHALLENGE: "turnstile" }), "turnstile");
  assert.equal(challengeUnder({ NODE_ENV: "production", FAUCET_CHALLENGE: "turnstile" }), "turnstile");
});

test("a Turnstile key beside pow serves, and is called out as ignored", () => {
  // The warning is the operator's only notice that the key stopped meaning anything.
  assert.equal(challengeUnder({ TURNSTILE_SECRET_KEY: "sk" }, "serving"), "OK");
  assert.match(challengeUnder({ TURNSTILE_SECRET_KEY: "sk" }, "serving-stderr"), /TURNSTILE_SECRET_KEY is set and IGNORED: the gate is pow/);
  assert.doesNotMatch(challengeUnder({}, "serving-stderr"), /IGNORED/, "no key, no warning");
});

test("THE GATE BEING OFF IN PRODUCTION IS SAID AT BOOT, and is silent for local work", () => {
  // A .env.local copied from a dev template sets FAUCET_CHALLENGE=none; next start reads
  // .env.local in production too; before this the box served ungated and said nothing.
  assert.match(challengeUnder({ NODE_ENV: "production", FAUCET_CHALLENGE: "none" }, "serving-stderr"), /ANTI-ABUSE GATE IS OFF/);
  assert.doesNotMatch(challengeUnder({ FAUCET_CHALLENGE: "none" }, "serving-stderr"), /GATE IS OFF/, "not in development");
  assert.doesNotMatch(
    challengeUnder({ NODE_ENV: "production", RATE_LIMIT_SALT: "b1946ac92492d2347c6235b4d2611184e0f4a3a5c9e01f8a2b3c4d5e6f708192" }, "serving-stderr"),
    /GATE IS OFF/, "not with the gate on",
  );
});

test("challenge=none needs no salt even when serving, so local work is unaffected", () => {
  // saltGuard only guards an ACTIVE gate. If this starts throwing, the guard has
  // widened and every test double that runs saltless breaks with it.
  assert.equal(challengeUnder({ NODE_ENV: "production", FAUCET_CHALLENGE: "none" }, "serving"), "OK");
});
