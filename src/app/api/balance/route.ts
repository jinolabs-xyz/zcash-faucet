/**
 * POST /api/balance {address} - balance lookup.
 * Transparent addresses: queried on-chain via lightwalletd (public UTXOs).
 * Shielded addresses: NOT queryable by address (private by design) - the caller
 * needs the viewing key. We return a clear explanation instead of a number.
 *
 * The address travels in the body, not the query string (risk register II, R-36).
 * A query string is the one part of a request every hop keeps by default: the
 * proxy's access log, a browser's history, a referrer. The ledger refuses to store
 * an address in the clear and the request that looks one up should not either.
 * GET is answered with a 405 that says so rather than silently ignored.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ZATOSHI_PER_TAZ } from "@/lib/config";
import { validateTestnetAddress } from "@/lib/zcash/address";
import { getTaddressBalance } from "@/lib/zcash/grpc";
import { withApi, apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ address: z.string().max(512) });

export const GET = withApi("balance", async (_req: NextRequest, api) => {
  const res = apiError(405, "Send the address in a POST body ({\"address\": …}); it is not accepted in the URL, so it never reaches a log.", api);
  res.headers.set("Allow", "POST");
  return res;
});

export const POST = withApi("balance", async (req: NextRequest, api) => {
  let address: string;
  try {
    ({ address } = BodySchema.parse(await req.json().catch(() => ({}))));
  } catch {
    return apiError(400, "Invalid request.", api);
  }
  address = address.trim();
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
