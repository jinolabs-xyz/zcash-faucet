/** GET /api/status — backend reachability, faucet policy, and wallet balance. */
import { NextResponse } from "next/server";
import { config, ZATOSHI_PER_TAZ } from "@/lib/config";
import { classifyMiner } from "@/lib/minerHeartbeat";
import { readMinerHeartbeat } from "@/lib/minerHeartbeatFile";
import { pingBackend } from "@/lib/zcash/lightwalletd";
import { safeBalance } from "@/lib/zcash/send";
import { getSendQueue } from "@/lib/zcash/queue";
import { getNodeStatus } from "@/lib/zcash/nodeStatus";
import { getReserveReconciler } from "@/lib/reserve/reconciler";
import { withApi } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi("status", async () => {
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
    miningAddress: config.miningAddress,
    // Mainnet, for donations toward running the project. Validated in config, so
    // an empty string here means unset OR rejected, and the UI treats both the
    // same: show nothing rather than a doubtful address for real funds.
    maintenanceAddress: config.maintenanceAddress,
    queueDepth: getSendQueue().depth,
    backend,
    node, // { ready, syncPercent, height, nodeHeight } or null while the wallet is down
    // What the miner is DOING, not what an operator configured. `active` stays for
    // compatibility, but it is the intent flag and must not be read as behaviour:
    // it said "on" for 70 minutes on 2026-07-31 while the miner produced nothing.
    miner: {
      active: config.miner.active,
      ...classifyMiner(readMinerHeartbeat(), config.miner.active, Date.now()),
    },
    // Refill loop state. spendableTaz uses this request's balance read (fresher
    // than the reconciler's last tick); refilling is the reconciler's decision.
    reserve: { ...getReserveReconciler().status, spendableTaz: balanceTaz },
  });
});
