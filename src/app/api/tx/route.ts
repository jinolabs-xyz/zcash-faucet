/**
 * GET /api/tx?txid=… — does OUR node know this transaction, and how deep is it.
 *
 * Exists because a link to a public explorer is not evidence: they render a
 * page for any 64-hex string (#71).
 */
import { NextRequest, NextResponse } from "next/server";
import { getTxStatus } from "@/lib/zcash/txstatus";
import { withApi, apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi("tx", async (req: NextRequest, api) => {
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
