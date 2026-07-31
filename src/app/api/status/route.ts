/** GET /api/status — backend reachability, faucet policy, and wallet balance. */
import { NextResponse } from "next/server";
import { config, ZATOSHI_PER_TAZ } from "@/lib/config";
import { classifyIntegrity } from "@/lib/boxIntegrity";
import { readBoxIntegrity } from "@/lib/boxIntegrityFile";
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
    // Does the box have what the repo says it must? COUNTS ONLY, never file names:
    // this endpoint is public, and naming what is missing from a production box is
    // reconnaissance. live-smoke asserts this from outside every 15 minutes, which
    // is the only signal that has ever reached us unprompted.
    box: classifyIntegrity(readBoxIntegrity(), Date.now()),
    node, // { ready, syncPercent, height, nodeHeight } or null while the wallet is down
    miner: { active: config.miner.active },
    // Refill loop state. spendableTaz uses this request's balance read (fresher
    // than the reconciler's last tick); refilling is the reconciler's decision.
    reserve: { ...getReserveReconciler().status, spendableTaz: balanceTaz },
  });
});
