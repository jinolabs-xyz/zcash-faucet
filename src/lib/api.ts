/**
 * One wrapper for every API route: a request id on each response, one JSON log
 * line per request, and a catch-all that turns an unhandled throw into a
 * generic 500. The client never sees a stack or an internal message; the
 * operator gets the full error server-side, joined to the response by the
 * request id.
 *
 * Framework-light on purpose: works on plain Request/Response (NextRequest and
 * NextResponse are subclasses), so it is unit-testable under node --test with
 * no Next.js runtime.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { clientIp } from "./clientIp.ts";
import { fingerprintIp } from "./privacy.ts";

/**
 * WHICH GATE REFUSED. One value per apiError call site, on the log line that is written for
 * EVERY request, so a refusal histogram is a group-by and never a regex over prose.
 *
 * On the info line and not the error line, because the error line exists only where a site
 * remembered to call logError - thirteen of the nineteen refusal sites in the claim route never
 * did, so a histogram built on it would have classified the wallet-lag refusals and nothing else
 * (SDE-Research, item 3). A field on the always-written line cannot be forgotten per site.
 *
 * REQUIRED on apiError rather than optional: an optional field is a site that forgets, and the
 * whole point is that forgetting fails at compile time. Grouped by what the number MEANS, which
 * is the distinction the old "one in four" estimate collapsed:
 *   REJECTED  the caller's mistake - not a faucet defect
 *   REFUSED   a gate declined by design - a service the visitor did not get, still not a defect
 *   FAILED    ours
 */
export const GATES = [
  // REJECTED. The 400s are split because they have different remedies: a malformed body is
  // a client bug, a bad address is the visitor's typo, an unknown network is a stale link -
  // and in an 18-hour window they were 29% of all claim requests as ONE bucket (SDE-Research).
  "badBody",          // the request body is not what the route reads: not JSON, wrong shape
  "badAddress",
  "badNetwork",
  "badTxid",
  "methodNotAllowed",
  "notFound",
  "powRequired",
  "powFailed",
  "challengeSpent",
  "cooldown",         // per address, per ip, or per subnet
  "lookupRate",       // too many /api/tx lookups
  "recipient",        // the wallet would not pay that address
  "emptyMessage",     // feedback: nothing to send. NOT "empty", which is the faucet
  "tooLong",          // feedback: over the body cap
  "feedbackRate",     // feedback: the per-fingerprint daily cap
  // REFUSED
  "ctazDisabled",
  "draining",         // the process is restarting
  "sendHealth",
  "empty",
  "freshness",        // chain freshness could not be established
  "walletLag",        // the wallet is behind its own node
  "ctazReadiness",
  "dailyCap",
  "busy",
  "notReady",         // /api/ready answering 503: the watchdog polls it twice a minute
  // FAILED
  "sendFailed",       // definite: nothing left the wallet
  "sendUnknown",      // lost the reply: coins may be on their way
  "backend",          // a chain backend we depend on did not answer
  "ledger",           // our own database refused a write
  "accountFailed",    // /api/account could not generate one
  "unhandled",        // the catch-all 500
  // THE BUCKET THAT MUST EXIST. A 4xx/5xx that reached the boundary with no gate, or with a
  // value not in this list, lands here rather than nowhere. Its size is the histogram's own
  // blind spot, and a spec that cannot report its blind spot reports success by silence.
  "unclassified",
] as const;
export type Gate = (typeof GATES)[number];
const GATE_SET: ReadonlySet<string> = new Set(GATES);
/** True only for a member of the closed set. A cast puts a string in the TYPE; this is the guard. */
export function isGate(v: unknown): v is Gate {
  return typeof v === "string" && GATE_SET.has(v);
}

/** apiError writes the gate through this; nothing else can, and nothing else should. */
export const SET_GATE = Symbol("setGate");

export interface ApiCtx {
  requestId: string;
  /** Record an internal error with full detail. Server log only, never the client. */
  logError(err: unknown, note?: string): void;
  /** Recorded by apiError; read by withApi when it writes the info line. Null on a success. */
  readonly gate: Gate | null;
  [SET_GATE](gate: Gate): void;
}

// No wallet claim here: this fires for ANY route, and only the faucet handler
// knows whether a send was in flight. It states its own wallet outcome itself.
const GENERIC_500 = "Something went wrong on our side. Try again in a moment.";

function logLine(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

/**
 * Standard error body: { ok:false, error, requestId }, plus route extras (e.g. retryAfterSeconds).
 *
 * Records `gate` on the ctx so the info line carries it. The body does not: the gate is for the
 * operator's histogram, and the visitor already gets the sentence and, where a route chooses,
 * `kind`. Keeping them separate means a wording change never moves a bucket.
 */
export function apiError(status: number, error: string, ctx: ApiCtx, gate: Gate, extra?: Record<string, unknown>): Response {
  ctx[SET_GATE](gate);
  return Response.json({ ok: false, error, requestId: ctx.requestId, ...extra }, { status });
}

export function withApi(
  route: string,
  handler: (req: NextRequest, ctx: ApiCtx) => Response | Promise<Response>,
): (req: NextRequest) => Promise<Response> {
  return async (req) => {
    const requestId = randomUUID();
    const started = Date.now();
    let gate: Gate | null = null;
    const ctx: ApiCtx = {
      requestId,
      get gate() { return gate; },
      [SET_GATE](g) { gate = g; },
      logError(err, note) {
        logLine({
          level: "error",
          requestId,
          route,
          note: note ?? null,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      },
    };

    let res: Response;
    try {
      res = await handler(req, ctx);
    } catch (err) {
      ctx.logError(err, "unhandled");
      res = apiError(500, GENERIC_500, ctx, "unhandled");
    }

    // Raw IP never touches the log, only the salted fingerprint.
    const ip = clientIp(req);
    // LABELLED AT THE BOUNDARY, NOT TRUSTED FROM THE SITE. Three things a per-site label cannot
    // guarantee are settled here, once, on the real status the response carries:
    //   - a 4xx/5xx built without apiError (a ternary status, a bare Response) is "unclassified",
    //     which is a bucket with a size rather than a line that never appears;
    //   - a value that is not in the closed set - reachable only by a cast, and a cast is how a
    //     visitor's address would reach this log beside their ipHash - is ALSO "unclassified",
    //     and the value itself is never written;
    //   - a success carries null, and "success" is status < 400, not === 200: /api/feedback
    //     answers 202 and the histogram must count it as PAID, not as a refusal.
    const g = ctx.gate;
    const labelled: Gate | null = res.status < 400 ? null : isGate(g) ? g : "unclassified";
    logLine({
      level: "info",
      requestId,
      method: req.method,
      path: new URL(req.url).pathname,
      status: res.status,
      ms: Date.now() - started,
      gate: labelled,
      ipHash: ip ? fingerprintIp(ip) : null,
    });
    res.headers.set("x-request-id", requestId);
    return res;
  };
}

/**
 * THE FRAMEWORK'S OWN 405 WRITES NO LINE AT ALL. A method a route does not export never reaches
 * withApi, so it is not even "unclassified" - it is absent. Every route exports this for the
 * methods it does not serve, so the refusal is labelled and logged like any other; a repo row
 * holds every route to the full set.
 */
export const notAllowed = withApi("method", (_req, ctx) =>
  apiError(405, "That method is not supported on this endpoint.", ctx, "methodNotAllowed"));

/** The methods a route must account for, either by serving or by exporting `notAllowed`. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
