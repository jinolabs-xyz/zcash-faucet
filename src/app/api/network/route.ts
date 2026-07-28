/** GET /api/network — live testnet chain info via lightwalletd (Network tab). */
import { NextResponse } from "next/server";
import { getLightdInfo, getLatestBlock } from "@/lib/zcash/grpc";
import { withApi } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi("network", async (_req, api) => {
  try {
    const [{ info, endpoint }, latest] = await Promise.all([getLightdInfo(), getLatestBlock()]);
    const tip = Number(latest.height);
    const estimated = Number(info.estimatedHeight || info.blockHeight);
    const behind = Number.isFinite(estimated) ? Math.max(0, estimated - tip) : null;

    return NextResponse.json({
      ok: true,
      reachable: true,
      endpoint,
      chainName: info.chainName,
      version: info.version,
      vendor: info.vendor,
      blockHeight: tip,
      estimatedHeight: estimated,
      blocksBehind: behind,
      synced: behind !== null && behind <= 2,
      consensusBranchId: info.consensusBranchId,
    });
  } catch (err) {
    // gRPC errors can embed endpoint internals; log them, keep the body plain.
    api.logError(err, "lightwalletd unreachable");
    return NextResponse.json({
      ok: false,
      reachable: false,
      error: "All lightwalletd endpoints are unreachable right now.",
      requestId: api.requestId,
    });
  }
});
