/**
 * GET /api/tx?txid=… - does OUR node know this transaction, and how deep is it.
 *
 * Exists because a link to a public explorer is not evidence: they render a
 * page for any 64-hex string (#71).
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getTxStatus } from "@/lib/zcash/txstatus";
import { createRateLimiter } from "@/lib/rateLimit";
import { fingerprintIp } from "@/lib/privacy";
import { clientIp } from "@/lib/clientIp";
import { withApi, apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// globalThis so route bundles and hot reloads share one limiter instead of
// silently starting fresh, same pattern as the send queue.
const g = globalThis as unknown as { __faucetTxLimiter?: ReturnType<typeof createRateLimiter> };
const limiter = (g.__faucetTxLimiter ??= createRateLimiter({
  windowSeconds: config.txLookup.windowSeconds,
  max: config.txLookup.max,
}));

export const GET = withApi("tx", async (req: NextRequest, api) => {
  // Every lookup costs a wallet RPC, so this is worth limiting even though it
  // moves no money. Keyed on the salted fingerprint, never the raw IP.
  //
  // No trustworthy IP means no per-IP limit, matching the claim path. Denying
  // instead would break the receipt poll for anyone behind a proxy we are not
  // configured to trust.
  const raw = clientIp(req);
  if (raw) {
    const verdict = limiter.check(fingerprintIp(raw));
    if (!verdict.allowed) {
      return apiError(429, "Too many lookups. Slow down for a moment.", api, {
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    }
  }

  const txid = req.nextUrl.searchParams.get("txid")?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/i.test(txid)) {
    return apiError(400, "Not a transaction id. Expected 64 hex characters.", api);
  }

  const status = await getTxStatus(txid);
  return NextResponse.json({
    ok: true,
    txid,
    // null means our wallet could not answer, which is not the same as "no".
    known: status.known,
    confirmations: status.confirmations,
    height: status.height,
  });
});
