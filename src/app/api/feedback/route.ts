/**
 * POST /api/feedback - a visitor's message, queued for delivery to the operator.
 *
 * THE APP DOES NOT DELIVER IT AND DOES NOT KNOW HOW. It writes a row and answers 202; a
 * timer on the box drains unsent rows to Signal over loopback. That seam is the design and
 * it is a security decision rather than a convenience.
 *
 * This is the only unauthenticated public WRITE path on the site that is not a claim.
 * Giving the public-facing container outbound network access so a form can reach a webhook
 * is how an SSRF surface gets built by accident, and we have already had docker's publish
 * rules bypass ufw and leave the wallet RPC internet-reachable for nine days - the same
 * mistake wearing different clothes. So the container gets no egress, and the failure mode
 * is a row that sits there rather than a request that hangs.
 *
 * 202, NEVER 200. The page must not tell anyone their message was delivered, because at the
 * moment we answer it has not been. Same rule the rest of this codebase spent the week on:
 * do not claim more than you know.
 */
import { NextResponse, type NextRequest } from "next/server";
import { withApi, apiError, notAllowed } from "@/lib/api";
import { clientIp } from "@/lib/clientIp";
import { fingerprintIp } from "@/lib/privacy";
import { recordFeedback, MAX_FEEDBACK_BODY } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi("feedback", async (req: NextRequest, api) => {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return apiError(400, "The request body is not JSON.", api, "badBody", { kind: "bad-request" });
  }
  // Read as unknown and narrow, rather than casting: this body is whatever a stranger sent.
  const b = payload as { body?: unknown; replyTo?: unknown } | null;
  if (typeof b?.body !== "string") {
    return apiError(400, "The request needs a body string.", api, "badBody", { kind: "bad-request" });
  }
  // A non-string replyTo is dropped rather than refused - it is optional, and rejecting the
  // whole message because an optional field arrived malformed loses something someone wrote.
  const replyTo = typeof b.replyTo === "string" ? b.replyTo : null;

  const rawIp = clientIp(req);
  const result = await recordFeedback({
    body: b.body,
    replyTo,
    ipHash: rawIp ? fingerprintIp(rawIp) : null,
    now: Date.now(),
  });

  if (result.ok) {
    // "queued", not "sent". The word is the contract with the page.
    return NextResponse.json({ ok: true, kind: "queued" }, { status: 202 });
  }
  switch (result.reason) {
    case "empty":
      // "emptyMessage", not "empty": that gate already means the FAUCET is empty.
      return apiError(400, "The message is empty.", api, "emptyMessage", { kind: "empty" });
    case "too-long":
      return apiError(400, "The message is too long.", api, "tooLong", { kind: "too-long", maxBody: MAX_FEEDBACK_BODY });
    case "rate":
      return apiError(429, "Too many messages today. Try again tomorrow.", api, "feedbackRate", { kind: "rate" });
    default:
      // The ledger refused. Logged with a request id so it is findable, and the sender is
      // told plainly rather than being handed a 202 for a row that does not exist.
      api.logError(new Error("feedback write refused by the ledger"), "feedback");
      return apiError(503, "We could not store the message right now. Try again shortly.", api, "ledger", { kind: "ledger" });
  }
});
// Methods this route does not serve: labelled 405s, not the framework's silent one.
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
