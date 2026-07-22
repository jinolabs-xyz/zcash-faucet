/** GET /api/status — backend reachability, faucet policy, and wallet balance. */
import { NextResponse } from "next/server";
import { config, ZATOSHI_PER_TAZ } from "@/lib/config";
import { pingBackend } from "@/lib/zcash/lightwalletd";
import { safeBalance } from "@/lib/zcash/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [backend, balanceZat] = await Promise.all([pingBackend(), safeBalance()]);

  const balanceTaz = balanceZat === null ? null : Number(balanceZat) / Number(ZATOSHI_PER_TAZ);
  const empty =
    balanceZat !== null && balanceZat < config.dripZatoshi + config.minReserveZatoshi;

  return NextResponse.json({
    network: config.network,
    dripTaz: config.dripTaz,
    cooldownSeconds: config.cooldownSeconds,
    sender: config.sender,
    turnstileEnabled: config.turnstile.enabled,
    balanceTaz, // null = unknown (real sender not wired yet)
    empty,
    donationAddress: config.donationAddress,
    backend,
  });
}
