/** GET /api/network — live testnet chain info via lightwalletd (Network tab). */
import { NextResponse } from "next/server";
import { getLightdInfo, getLatestBlock } from "@/lib/zcash/grpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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
    return NextResponse.json({
      ok: false,
      reachable: false,
      error: err instanceof Error ? err.message : "All lightwalletd endpoints unreachable.",
    });
  }
}
