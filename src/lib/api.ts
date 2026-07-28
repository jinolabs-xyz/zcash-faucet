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

export interface ApiCtx {
  requestId: string;
  /** Record an internal error with full detail. Server log only, never the client. */
  logError(err: unknown, note?: string): void;
}

// No wallet claim here: this fires for ANY route, and only the faucet handler
// knows whether a send was in flight. It states its own wallet outcome itself.
const GENERIC_500 = "Something went wrong on our side. Try again in a moment.";

function logLine(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

/** Standard error body: { ok:false, error, requestId }, plus route extras (e.g. retryAfterSeconds). */
export function apiError(status: number, error: string, ctx: ApiCtx, extra?: Record<string, unknown>): Response {
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
      res = apiError(500, GENERIC_500, ctx);
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
      ipHash: ip ? fingerprintIp(ip) : null,
    });
    res.headers.set("x-request-id", requestId);
    return res;
  };
}
