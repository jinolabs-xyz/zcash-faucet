import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";

// One trusted proxy so the ipHash path is exercisable via X-Forwarded-For.
process.env.TRUSTED_PROXY_COUNT = "1";

const { withApi, apiError } = await import("./api.ts");

// The wrapper is framework-light: a plain Request exercises it fully.
const asReq = (r: Request) => r as unknown as NextRequest;

let lines: Array<Record<string, unknown>> = [];
const realLog = console.log;
beforeEach(() => {
  lines = [];
  console.log = (s: string) => {
    lines.push(JSON.parse(s));
  };
});
afterEach(() => {
  console.log = realLog;
});

test("a throwing handler becomes a generic 500 that leaks nothing", async () => {
  const route = withApi("boomtest", () => {
    throw new Error("secret internal detail: db password is hunter2");
  });
  const res = await route(asReq(new Request("http://faucet.test/api/boom")));
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.ok, false);
  assert.ok(!JSON.stringify(body).includes("hunter2"), "internal detail reached the client");
  assert.ok(!JSON.stringify(body).includes("at "), "stack frame reached the client");
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers.get("x-request-id"), body.requestId);

  // The operator side DOES get the real error, joined by the request id.
  const errLine = lines.find((l) => l.level === "error");
  assert.ok(errLine, "no error log line");
  assert.match(String(errLine.error), /hunter2/);
  assert.equal(errLine.requestId, body.requestId);
});

test("a successful response passes through and gains the request id header", async () => {
  const route = withApi("oktest", () => Response.json({ ok: true, value: 7 }));
  const res = await route(asReq(new Request("http://faucet.test/api/ok")));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, value: 7 });
  assert.match(res.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
});

test("every request writes one structured log line with the agreed fields", async () => {
  const route = withApi("logtest", () => Response.json({ ok: true }));
  await route(asReq(new Request("http://faucet.test/api/logged?x=1", { method: "GET" })));

  const info = lines.find((l) => l.level === "info");
  assert.ok(info, "no info log line");
  assert.equal(info.method, "GET");
  assert.equal(info.path, "/api/logged"); // query string stays out of the logs
  assert.equal(info.status, 200);
  assert.equal(typeof info.ms, "number");
  assert.equal(info.ipHash, null); // no trusted XFF on this request
});

test("logs carry the salted ip fingerprint, never the raw ip", async () => {
  const route = withApi("iptest", () => Response.json({ ok: true }));
  await route(
    asReq(new Request("http://faucet.test/api/ip", { headers: { "x-forwarded-for": "203.0.113.7" } })),
  );
  const info = lines.find((l) => l.level === "info");
  assert.match(String(info?.ipHash), /^[0-9a-f]{16,64}$/);
  assert.ok(!JSON.stringify(lines).includes("203.0.113.7"), "raw ip reached the logs");
});

test("apiError produces the one error shape, extras included", async () => {
  const ctx = { requestId: "rid-1", logError: () => {} };
  const res = apiError(429, "Cooldown.", ctx, { retryAfterSeconds: 60 });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { ok: false, error: "Cooldown.", requestId: "rid-1", retryAfterSeconds: 60 });
});
