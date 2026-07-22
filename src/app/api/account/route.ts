/**
 * POST /api/account — generate a throwaway TESTNET account.
 * Server-side randomness, never stored or logged. Body: { type: "transparent" | "shielded" }.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateThrowaway } from "@/lib/zcash/keys";

export const runtime = "nodejs";

const BodySchema = z.object({ type: z.enum(["transparent", "shielded"]).default("transparent") });

export async function POST(req: NextRequest) {
  let type: "transparent" | "shielded";
  try {
    ({ type } = BodySchema.parse(await req.json().catch(() => ({}))));
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const acct = generateThrowaway(type);
  // Note: the secret is returned exactly once and never persisted server-side.
  return NextResponse.json({ ok: true, account: acct });
}
