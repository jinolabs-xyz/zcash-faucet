/** GET /api/status — backend reachability, faucet policy, and wallet balance. */
import { NextResponse } from "next/server";
import { config, ZATOSHI_PER_TAZ } from "@/lib/config";
import { pingBackend } from "@/lib/zcash/lightwalletd";
import { safeBalance } from "@/lib/zcash/send";
import { getSendQueue } from "@/lib/zcash/queue";
import { getNodeStatus } from "@/lib/zcash/nodeStatus";
import { getReserveReconciler } from "@/lib/reserve/reconciler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [backend, balanceZat, node] = await Promise.all([pingBackend(), safeBalance(), getNodeStatus()]);

  const balanceTaz = balanceZat === null ? null : Number(balanceZat) / Number(ZATOSHI_PER_TAZ);
  const empty =
    balanceZat !== null && balanceZat < config.dripZatoshi + config.minReserveZatoshi;

  return NextResponse.json({
    network: config.network,
    dripTaz: config.dripTaz,
    cooldownSeconds: config.cooldownSeconds,
    sender: config.sender,
    turnstileEnabled: config.turnstile.enabled,
    challenge: config.challenge, // "pow" | "turnstile" | "none"
    balanceTaz, // null = unknown (backend not ready / still syncing)
    empty,
    donationAddress: config.donationAddress,
    queueDepth: getSendQueue().depth,
    backend,
    node, // { ready, syncPercent, height, nodeHeight } or null while the wallet is down
    miner: { active: config.miner.active },
    // Refill loop state. spendableTaz uses this request's balance read (fresher
    // than the reconciler's last tick); refilling is the reconciler's decision.
    reserve: { ...getReserveReconciler().status, spendableTaz: balanceTaz },
  });
}
