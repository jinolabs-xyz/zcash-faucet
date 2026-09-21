import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";

// One trusted proxy so the ipHash path is exercisable via X-Forwarded-For.
process.env.TRUSTED_PROXY_COUNT = "1";
// THE ORACLE PINS, though nothing here dials: the rows below read the route files as TEXT
// (readFileSync, never import) and the oracle-pin row (zcash/oraclePin.test.ts) counts any path
// that resolves to a reaching module, on purpose, because a spawned child reaches through a
// string too. It cannot tell a text read from an import, so the pins sit here for the row and
// cost nothing; the merge queue was the first run to say so (#725 landed after this head).
process.env.HOSH_URL = "http://127.0.0.1:9/";
process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:9";
process.env.TIP_ORACLE_ENDPOINT = "";

const { withApi, apiError } = await import("./api.ts");
import type { ApiCtx, Gate } from "./api.ts";
import { readFileSync, readdirSync } from "node:fs";
const { GATES: GATE_LIST } = await import("./api.ts");
// THE SAME SET THE BOUNDARY CHECKS, not a copy. A copy in a test is a second source of truth that
// drifts the day a gate is added, and then the count row passes on a token the boundary rejects.
const GATES = new Set<Gate>(GATE_LIST);
const _unused_ = new Set<Gate>([
  "badBody","badAddress","badNetwork","methodNotAllowed","notFound","powRequired","powFailed","challengeSpent","cooldown",
  "lookupRate","recipient","ctazDisabled","draining","sendHealth","empty","freshness","walletLag",
  "ctazReadiness","dailyCap","busy","sendFailed","sendUnknown","backend","unhandled",
]);
void _unused_;

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
  // Through withApi, so this is the REAL ctx - the one whose gate is read-only from outside and
  // written only by apiError. Hand-building a ctx here would test a shape the boundary never sees.
  let seen: ApiCtx | null = null;
  const route = withApi("shape", (_req, ctx) => { seen = ctx; return apiError(429, "Cooldown.", ctx, "cooldown", { retryAfterSeconds: 60 }); });
  const res = await route(asReq(new Request("http://faucet.test/api/x", { method: "POST" })));
  assert.equal(res.status, 429);
  // The gate is for the operator's histogram, not the visitor. Putting it in the body would make
  // the enum part of the public contract, and a wording change could then move a bucket.
  const body = await res.json();
  assert.equal(body.gate, undefined);
  assert.deepEqual(body, { ok: false, error: "Cooldown.", requestId: seen!.requestId, retryAfterSeconds: 60 });
  assert.equal(seen!.gate, "cooldown", "recorded on the ctx for the info line");
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

/**
 * The argument list of a call, from the character after `(` to its matching `)`, with string
 * literals skipped so a `);` inside a sentence cannot end the scan early - which is exactly
 * how the first version of the row below was defeated (CTO, #720 F5).
 */
function callArgs(src: string, openParen: number): string {
  let depth = 1, i = openParen + 1, quote: string | null = null;
  for (; i < src.length && depth > 0; i++) {
    const c = src[i], n = src[i + 1];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    // COMMENTS TOO, not only strings. A `/** ... */` inside the body carried "watchdog's",
    // the apostrophe opened a phantom string, and the scan ended at the wrong paren - which
    // the M3 mutant found by surviving: the guard never saw the ready route's ternary at all.
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i = src.indexOf("*/", i + 2); if (i < 0) break; i++; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  return src.slice(openParen + 1, i - 1);
}

test("item 3: no route answers a non-2xx with a direct JSON response unless it labels itself", () => {
  // THE ROW ON THE OTHER SIDE, second version. The first read one file and counted text; this
  // walks every route, parses each .json( call to its real closing paren, and flags a status
  // that is not a 2xx/3xx LITERAL - so a ternary (`ready ? 200 : 503`) and a variable are
  // flagged too, not only a literal 503, because either can be an error the boundary would have
  // to call unclassified. A route may answer a non-2xx with its own body shape only if it labels
  // the gate itself through SET_GATE, which the ready route does.
  // The boundary is the real guard (F6); this is the second opinion that names the file.
  const apiDir = new URL("../app/api/", import.meta.url);
  const routes: string[] = [];
  const walk = (dir: URL) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) walk(child);
      else if (e.name === "route.ts") routes.push(child.pathname);
    }
  };
  walk(apiDir);
  assert.ok(routes.length >= 6, `expected the api routes, found ${routes.length}`);
  const offenders: string[] = [];
  for (const file of routes) {
    const src = readFileSync(file, "utf8");
    const labelsItself = /\[SET_GATE\]\(/.test(src);
    const re = /(?:NextResponse|Response)\.json\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const args = callArgs(src, m.index + m[0].length - 1);
      const st = args.match(/\bstatus:\s*([^,}\n]+)/);
      if (!st) continue;                                  // no status => 200
      const value = st[1].trim();
      if (/^[23]\d\d$/.test(value)) continue;             // a literal success
      if (labelsItself) continue;                          // ready: a ternary, labelled via the ctx
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${file.split("/src/")[1]}:${line} status ${value}`);
    }
  }
  assert.deepEqual(offenders, [], `direct non-2xx responses that carry no gate: ${offenders.join(", ")}`);
});

test("item 3: and the parser is not the regex it replaced - a `);` inside a sentence does not end the scan", () => {
  // The CTO's prose mutant: a 503 whose body string contains `);`. The old non-greedy match ended
  // there and the status fell outside it.
  // UNBALANCED on purpose: a lone `);` inside the sentence. A balanced "(see above);" would pass a
  // parser with no string handling at all, and that is the fixture I wrote first - the mutant
  // survived it, and the survivor was right.
  const src = 'x; NextResponse.json({ ok: false, error: "we stopped); try later" }, { status: 503 });';
  const i = src.indexOf("NextResponse.json(") + "NextResponse.json(".length - 1;
  const args = callArgs(src, i);
  assert.match(args, /status:\s*503/, "the status must be inside the parsed argument list");
});

test("F6: a 4xx/5xx that reached the boundary with no gate is 'unclassified', a bucket with a size", async () => {
  // A ternary status, a bare Response, a route that forgot: all land here rather than nowhere.
  // "unclassified" is the histogram's own blind spot made countable.
  const route = withApi("bare", () => new Response("nope", { status: 503 }));
  await route(asReq(new Request("http://faucet.test/api/x", { method: "GET" })));
  const info = lines.find((l) => l.level === "info");
  assert.equal(info?.gate, "unclassified");
});

test("F6: the success predicate is status < 400, not === 200 - a 202 is PAID, not a refusal", async () => {
  const route = withApi("accepted", () => Response.json({ ok: true, queued: true }, { status: 202 }));
  await route(asReq(new Request("http://faucet.test/api/feedback", { method: "POST" })));
  const info = lines.find((l) => l.level === "info");
  assert.equal(info?.status, 202);
  assert.equal(info?.gate, null, "202 must not fall into unclassified");
});

test("F4: a visitor's text cast into the gate NEVER reaches the log - the boundary checks the closed set", async () => {
  // The CTO's mutant R5b: a site emits `badAddress:<what the visitor typed>` through a cast. The
  // type cannot stop a cast; the boundary can. The value must be replaced by "unclassified" and
  // the text must not appear anywhere on the line, because it would sit beside the ipHash.
  const typed = "utest1qqqq-a-visitor-typed-this";
  const route = withApi("cast", (_req, ctx) =>
    apiError(400, "Bad address.", ctx, (`badAddress:${typed}` as unknown) as Gate));
  await route(asReq(new Request("http://faucet.test/api/faucet", { method: "POST" })));
  const info = lines.find((l) => l.level === "info");
  assert.equal(info?.gate, "unclassified");
  assert.ok(!JSON.stringify(lines).includes(typed), "the visitor's text reached the operator log");
});

test("F3: a method a route does not serve is a labelled 405, not the framework's silent one", async () => {
  const { notAllowed } = await import("./api.ts");
  const res = await notAllowed(asReq(new Request("http://faucet.test/api/tx", { method: "DELETE" })));
  assert.equal(res.status, 405);
  const info = lines.find((l) => l.level === "info");
  assert.equal(info?.gate, "methodNotAllowed");
  assert.equal(info?.method, "DELETE");
});

test("F3: every route under src/app/api accounts for every method, served or notAllowed", () => {
  // The catch-all 404 and the shared 405 only help if every route exports them. This holds each
  // route to the full set, so a new route cannot reintroduce the silent 405.
  const apiDir = new URL("../app/api/", import.meta.url);
  const routes: string[] = [];
  const walk = (dir: URL) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) walk(child);
      else if (e.name === "route.ts") routes.push(child.pathname);
    }
  };
  walk(apiDir);
  const short: string[] = [];
  for (const file of routes) {
    const src = readFileSync(file, "utf8");
    const have = new Set([...src.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\b/gm)].map((m) => m[1]));
    const missing = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => !have.has(m));
    if (missing.length) short.push(`${file.split("/src/")[1]} lacks ${missing.join(" ")}`);
  }
  assert.ok(routes.some((r) => r.includes("[...rest]")), "the 404 catch-all route must exist");
  assert.deepEqual(short, [], `routes with a silent 405: ${short.join("; ")}`);
});
