/**
 * GET /api/ready — readiness probe. Unlike /api/health (liveness: "is the web
 * process answering"), this reports whether the faucet can actually serve a
 * drip right now: backend reachable, node synced, and a spendable balance above
 * the drip + reserve. Returns 200 when ready, 503 with a reason when not.
 *
 * This is what an external uptime monitor, a load balancer, or the box watchdog
 * should poll. Liveness restarts a hung process; readiness decides whether to
 * send traffic and whether to page someone. Keeping them separate is what stops
 * a legitimate first sync from looking like an outage.
 */
import { NextResponse } from "next/server";
import { config, ZATOSHI_PER_TAZ } from "@/lib/config";
import { pingBackend } from "@/lib/zcash/lightwalletd";
import { safeBalance } from "@/lib/zcash/send";
import { getNodeStatus } from "@/lib/zcash/nodeStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [backend, balanceZat, node] = await Promise.all([pingBackend(), safeBalance(), getNodeStatus()]);

  // Order the checks cheapest-signal first so the reason is the most upstream cause.
  let reason: string | null = null;
  if (!backend.reachable) reason = "backend unreachable";
  else if (node && node.ready === false) reason = "node syncing";
  else if (balanceZat === null) reason = "wallet balance unknown";
  else if (balanceZat < config.dripZatoshi + config.minReserveZatoshi) reason = "below reserve, refilling";

  const ready = reason === null;
  const balanceTaz = balanceZat === null ? null : Number(balanceZat) / Number(ZATOSHI_PER_TAZ);

  return NextResponse.json(
    {
      ready,
      reason, // null when ready; otherwise the most upstream blocker
      node, // { ready, syncPercent, height, nodeHeight } or null
      backend: { reachable: backend.reachable },
      balanceTaz,
      ts: Math.floor(Date.now() / 1000),
    },
    { status: ready ? 200 : 503 },
  );
}
