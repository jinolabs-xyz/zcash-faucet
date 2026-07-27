/**
 * POST /api/account — generate a throwaway TESTNET account.
 * Shielded (default): a real Orchard account (address + spending key) via t2z.
 * Transparent (opt-in): a P2PKH key (WIF + tm… address), pure JS.
 * Server-side randomness, never stored or logged.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateTransparentAccount, type ThrowawayAccount } from "@/lib/zcash/keys";
import { generateShieldedAccount } from "@/lib/zcash/t2z";
import { withApi, apiError } from "@/lib/api";

export const runtime = "nodejs";

const BodySchema = z.object({ type: z.enum(["transparent", "shielded"]).default("shielded") });

export const POST = withApi("account", async (req: NextRequest, api) => {
  let type: "transparent" | "shielded";
  try {
    ({ type } = BodySchema.parse(await req.json().catch(() => ({}))));
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  try {
    if (type === "shielded") {
      const kp = await generateShieldedAccount();
      const account: ThrowawayAccount = {
        type: "shielded",
        shielded: true,
        address: kp.address,
        secret: kp.spendingKey,
        secretLabel: "Orchard spending key (testnet)",
        mock: false,
        warning:
          "Testnet throwaway. Real Orchard address + spending key — copy the key now, it isn't stored. " +
          "Testnet only; never reuse on mainnet.",
      };
      return NextResponse.json({ ok: true, account });
    }
    return NextResponse.json({ ok: true, account: generateTransparentAccount() });
  } catch (err) {
    api.logError(err, "account generation");
    return apiError(500, "Account generation failed on our side. Try again in a moment.", api);
  }
});
