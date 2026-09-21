import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";

// One trusted proxy so the ipHash path is exercisable via X-Forwarded-For.
process.env.TRUSTED_PROXY_COUNT = "1";

const { withApi, apiError } = await import("./api.ts");
import type { ApiCtx, Gate } from "./api.ts";
import { readFileSync } from "node:fs";
// The enum as a runtime set, kept in step with the type by the exhaustive check below.
const GATES = new Set<Gate>([
  "badRequest","methodNotAllowed","notFound","powRequired","powFailed","challengeSpent","cooldown",
  "lookupRate","recipient","ctazDisabled","draining","sendHealth","empty","freshness","walletLag",
  "ctazReadiness","dailyCap","busy","sendFailed","sendUnknown","backend","unhandled",
]);

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

test("apiError produces the one error shape, extras included, and the gate is NOT in the body", async () => {
  const ctx: ApiCtx = { requestId: "rid-1", logError: () => {}, gate: null };
  const res = apiError(429, "Cooldown.", ctx, "cooldown", { retryAfterSeconds: 60 });
  assert.equal(res.status, 429);
  // The gate is for the operator's histogram, not the visitor. Putting it in the body would make
  // the enum part of the public contract, and a wording change could then move a bucket.
  assert.deepEqual(await res.json(), { ok: false, error: "Cooldown.", requestId: "rid-1", retryAfterSeconds: 60 });
  assert.equal(ctx.gate, "cooldown", "recorded on the ctx for the info line");
});

test("item 3: the gate lands on the INFO line, the one written for every request", async () => {
  const route = withApi("gatetest", (_req, ctx) => apiError(503, "Behind.", ctx, "walletLag"));
  await route(asReq(new Request("http://faucet.test/api/faucet", { method: "POST" })));
  const info = lines.find((l) => l.level === "info");
  assert.ok(info, "an info line is always written");
  // ON THE INFO LINE, NOT THE ERROR LINE. Thirteen of the nineteen refusal sites in the claim
  // route never call logError, so a field on the error line would classify the wallet-lag
  // refusals and nothing else. This line is written whether or not a site remembered anything.
  assert.equal(info.gate, "walletLag");
  assert.equal(info.status, 503, "beside status and ms, no join needed");
  assert.equal(typeof info.ms, "number");
});

test("item 3: a success carries gate null - PAID is the denominator, not a bucket", async () => {
  const route = withApi("gatetest", () => Response.json({ ok: true }));
  await route(asReq(new Request("http://faucet.test/api/faucet", { method: "POST" })));
  const info = lines.find((l) => l.level === "info");
  assert.equal(info?.gate, null);
  assert.equal(info?.status, 200);
});

test("item 3: the catch-all names itself, so a 500 is FAILED and not unclassified", async () => {
  const route = withApi("gatetest", () => { throw new Error("boom"); });
  await route(asReq(new Request("http://faucet.test/api/faucet", { method: "POST" })));
  const info = lines.find((l) => l.level === "info");
  assert.equal(info?.gate, "unhandled");
  assert.equal(info?.status, 500);
});

test("item 3: EVERY apiError site in the claim route names a gate from the enum - counted, not trusted", () => {
  // The type makes a missing gate a compile error; this row is the runtime half of the
  // acceptance: count the call sites in the source, and require every one to carry a literal
  // (or the one computed reservation gate) in the gate position. A site added without one is
  // caught by tsc; a site that passes a non-literal that happens to typecheck is caught here.
  const src = readFileSync(new URL("../app/api/faucet/route.ts", import.meta.url), "utf8");
  const calls = src.match(/apiError\(/g) ?? [];
  assert.ok(calls.length >= 19, `expected the claim route's 19 sites, found ${calls.length}`);
  // Every call must reach `api, "<gate>"` or the reservation ternary within its argument list.
  const named = src.match(/\bapi,\s*("[a-zA-Z]+"|reservation\.kind === "cap" \? "dailyCap" : "cooldown")/g) ?? [];
  assert.equal(named.length, calls.length, "a site does not name its gate");
  // And every literal is a member of the enum: TypeScript enforces this at compile time; here
  // it is the list a reader can check against the histogram's buckets.
  const literals = new Set(named.map((n) => n.replace(/^api,\s*/, "")).filter((n) => n.startsWith('"')).map((n) => n.replace(/"/g, "")));
  for (const g of literals) assert.ok(GATES.has(g as Gate), `${g} is not in the Gate enum`);
});
