/**
 * GET /api/health - cheap liveness check for uptime pingers (UptimeRobot etc.)
 * and Render's health check. Deliberately does NO backend work (no gRPC, no DB)
 * so keep-alive pings don't hammer lightwalletd every few minutes.
 */
import { NextResponse } from "next/server";
import { withApi, notAllowed } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi("health", () =>
  NextResponse.json({ ok: true, service: "zcash-faucet", ts: Math.floor(Date.now() / 1000) }),
);
// Methods this route does not serve: labelled 405s, not the framework's silent one.
export const POST = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
