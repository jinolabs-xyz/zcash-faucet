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
export type Gate =
  // REJECTED. The 400s are split because they have different remedies: a malformed body is
  // a client bug, a bad address is the visitor's typo, an unknown network is a stale link -
  // and in an 18-hour window they were 29% of all claim requests as ONE bucket (SDE-Research).
  | "badBody"
  | "badAddress"
  | "badNetwork"
  | "badRequest"      // a route with only one way to be malformed
  | "methodNotAllowed"
  | "notFound"
  | "powRequired"
  | "powFailed"
  | "challengeSpent"
  | "cooldown"        // per address, per ip, or per subnet
  | "lookupRate"      // too many /api/tx lookups
  | "recipient"       // the wallet would not pay that address
  | "emptyMessage"    // feedback: nothing to send. NOT "empty", which is the faucet
  | "tooLong"         // feedback: over the body cap
  | "feedbackRate"    // feedback: the per-fingerprint daily cap
  // REFUSED
  | "ctazDisabled"
  | "draining"        // the process is restarting
  | "sendHealth"
  | "empty"
  | "freshness"       // chain freshness could not be established
  | "walletLag"       // the wallet is behind its own node
  | "ctazReadiness"
  | "dailyCap"
  | "busy"
  // FAILED
  | "sendFailed"      // definite: nothing left the wallet
  | "sendUnknown"     // lost the reply: coins may be on their way
  | "backend"         // a chain backend we depend on did not answer
  | "ledger"          // our own database refused a write
  | "unhandled";      // the catch-all 500

export interface ApiCtx {
  requestId: string;
  /** Record an internal error with full detail. Server log only, never the client. */
  logError(err: unknown, note?: string): void;
  /** Set by apiError; read by withApi when it writes the info line. Null on a success. */
  gate: Gate | null;
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
  ctx.gate = gate;
  return Response.json({ ok: false, error, requestId: ctx.requestId, ...extra }, { status });
}

export function withApi(
  route: string,
  handler: (req: NextRequest, ctx: ApiCtx) => Response | Promise<Response>,
): (req: NextRequest) => Promise<Response> {
  return async (req) => {
    const requestId = randomUUID();
    const started = Date.now();
    const ctx: ApiCtx = {
      requestId,
      gate: null,
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
    logLine({
      level: "info",
      requestId,
      method: req.method,
      path: new URL(req.url).pathname,
      status: res.status,
      ms: Date.now() - started,
      gate: ctx.gate,
      ipHash: ip ? fingerprintIp(ip) : null,
    });
    res.headers.set("x-request-id", requestId);
    return res;
  };
}
