/**
 * GET /api/balance?address=… - balance lookup.
 * Transparent addresses: queried on-chain via lightwalletd (public UTXOs).
 * Shielded addresses: NOT queryable by address (private by design) - the caller
 * needs the viewing key. We return a clear explanation instead of a number.
 */
import { NextRequest, NextResponse } from "next/server";
import { ZATOSHI_PER_TAZ } from "@/lib/config";
import { validateTestnetAddress } from "@/lib/zcash/address";
import { getTaddressBalance } from "@/lib/zcash/grpc";
import { withApi, apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi("balance", async (req: NextRequest, api) => {
  const address = req.nextUrl.searchParams.get("address")?.trim() ?? "";
  const info = validateTestnetAddress(address);
  if (!info.valid) {
    return apiError(400, info.reason ?? "Invalid address.", api);
  }

  if (info.shielded) {
    return NextResponse.json({
      ok: true,
      address,
      kind: info.kind,
      shielded: true,
      queryable: false,
      note: "Shielded balances are private. They can't be read from the address alone. Provide the viewing key in a wallet to see this balance.",
    });
  }

  // Transparent → on-chain lookup.
  try {
    const zat = await getTaddressBalance([address]);
    return NextResponse.json({
      ok: true,
      address,
      kind: info.kind,
      shielded: false,
      queryable: true,
      balanceTaz: Number(zat) / Number(ZATOSHI_PER_TAZ),
      balanceZat: zat.toString(),
    });
  } catch (err) {
    api.logError(err, "taddress balance lookup");
    return apiError(502, "Balance lookup failed. The chain backend is unreachable right now.", api);
  }
});
