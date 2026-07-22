/**
 * GET /api/health — cheap liveness check for uptime pingers (UptimeRobot etc.)
 * and Render's health check. Deliberately does NO backend work (no gRPC, no DB)
 * so keep-alive pings don't hammer lightwalletd every few minutes.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true, service: "zcash-faucet", ts: Math.floor(Date.now() / 1000) });
}
