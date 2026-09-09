/**
 * Every branch of the Turnstile verdict, without Cloudflare. The one that matters most
 * is the first: with no secret the old code returned true, so a box with
 * FAUCET_CHALLENGE=turnstile and a missing key served every claim ungated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTurnstileWith, SITEVERIFY_TIMEOUT_MS, type SiteverifyFetch } from "./turnstile.ts";

const ON = { enabled: true, secretKey: "sk-test", token: "tok" };
const answering = (status: number, body: string): SiteverifyFetch => async () =>
  new Response(body, { status, headers: { "content-type": "application/json" } });
const neverCalled: SiteverifyFetch = async () => {
  throw new Error("siteverify must not be called in this state");
};

test("no secret REFUSES, even with a token: a captcha with no key verifies nothing", async () => {
  assert.equal(await verifyTurnstileWith(neverCalled, { ...ON, enabled: false, secretKey: "" }), false);
});

test("no token refuses without asking Cloudflare", async () => {
  assert.equal(await verifyTurnstileWith(neverCalled, { ...ON, token: undefined }), false);
  assert.equal(await verifyTurnstileWith(neverCalled, { ...ON, token: "" }), false);
});

test("an explicit success passes, and the request carries secret, token and ip", async () => {
  let seen: URLSearchParams | null = null;
  const capture: SiteverifyFetch = async (_url, init) => {
    seen = init.body as URLSearchParams;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  assert.equal(await verifyTurnstileWith(capture, { ...ON, ip: "203.0.113.9" }), true);
  assert.equal(seen!.get("secret"), "sk-test");
  assert.equal(seen!.get("response"), "tok");
  assert.equal(seen!.get("remoteip"), "203.0.113.9");
});

test("anything short of success:true refuses: false, missing, a string, a non-2xx, a non-object", async () => {
  assert.equal(await verifyTurnstileWith(answering(200, '{"success":false}'), ON), false);
  assert.equal(await verifyTurnstileWith(answering(200, '{"error-codes":["timeout-or-duplicate"]}'), ON), false);
  assert.equal(await verifyTurnstileWith(answering(200, '{"success":"true"}'), ON), false);
  assert.equal(await verifyTurnstileWith(answering(500, '{"success":true}'), ON), false);
  assert.equal(await verifyTurnstileWith(answering(200, "true"), ON), false);
  assert.equal(await verifyTurnstileWith(answering(200, "not json"), ON), false);
});

test("a siteverify that hangs is refused at the timeout, not held until Cloudflare feels like it", async () => {
  // The fake honours the abort signal the way undici does, so this proves the signal
  // is wired, not that a timer exists somewhere.
  const hanging: SiteverifyFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    });
  // AbortSignal.timeout's timer is unref'd, so with nothing else alive node would end the
  // test before it fires ("promise resolution is still pending"). A real fetch holds a
  // socket; here a plain timer stands in for it.
  const keepAlive = setTimeout(() => {}, 5000);
  const t0 = Date.now();
  assert.equal(await verifyTurnstileWith(hanging, { ...ON, timeoutMs: 200 }), false);
  clearTimeout(keepAlive);
  const took = Date.now() - t0;
  assert.ok(took >= 150 && took < 1000, `expected the refusal at about 200 ms, took ${took} ms`);
});

test("the production timeout is pinned, and is shorter than a claim's patience", () => {
  assert.equal(SITEVERIFY_TIMEOUT_MS, 5000);
});
