/** GET /api/status — backend reachability, faucet policy, and wallet balance. */
import { NextResponse } from "next/server";
import { config, ZATOSHI_PER_TAZ } from "@/lib/config";
import { classifyIntegrity } from "@/lib/boxIntegrity";
import { readBoxIntegrity } from "@/lib/boxIntegrityFile";
import { pingBackend } from "@/lib/zcash/lightwalletd";
import { safeBalance } from "@/lib/zcash/send";
import { getSendQueue } from "@/lib/zcash/queue";
import { countDrips } from "@/lib/db";
import { getNodeStatus } from "@/lib/zcash/nodeStatus";
import { getReserveReconciler } from "@/lib/reserve/reconciler";
import { readMinerHeartbeat } from "@/lib/miner/read";
import { isActive } from "@/lib/miner/heartbeat";
import { withApi } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whole seconds on the wire. Null stays null: an age we do not have is not zero. */
const round = (n: number | null) => (n == null ? null : Math.round(n));

export const GET = withApi("status", async () => {
  const [backend, balanceZat, node] = await Promise.all([pingBackend(), safeBalance(), getNodeStatus()]);
  // Synchronous and off the await chain: a few hundred bytes from a bind mount, so it
  // does not belong in the Promise.all with three network calls.
  const minerReading = readMinerHeartbeat(config.miner.heartbeatPath);

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
    // How many drips this faucet has served: ever, last 7 UTC days, last 30. From the
    // privacy-safe per-day counter, not the claims table, whose rows retention deletes.
    // Null when the ledger will not answer; an unknown count is not zero.
    drips: await countDrips(Date.now()),
    backend,
    // Does the box have what the repo says it must? COUNTS ONLY, never file names:
    // this endpoint is public, and naming what is missing from a production box is
    // reconnaissance. live-smoke asserts this from outside every 15 minutes, which
    // is the only signal that has ever reached us unprompted.
    box: classifyIntegrity(readBoxIntegrity(), Date.now()),
    node, // { ready, syncPercent, height, nodeHeight } or null while the wallet is down
    // OBSERVED, not configured. `active` used to be config.miner.active straight from
    // an env flag, so it could not be false while the miner was broken, and it said
    // "on" for 70 minutes through an outage. It is derived from the heartbeat now, and
    // `state` carries what a boolean cannot: stalled and not-writing and cannot-verify
    // are three different findings that all used to arrive as "on" or "off".
    //
    // The reading is sent through as-is rather than reshaped. The page renders it with
    // the same minerRow() the tests cover, so a reshaping layer here would be a place
    // for the wire format and the tested format to drift apart.
    //
    // lastErrorStage is a fixed token, never a message. The miner's raw errors are the
    // transport's and can carry the RPC URL, which can carry credentials in its
    // userinfo, and this response is public.
    miner: {
      ...minerReading,
      beatAgoSeconds: round(minerReading.beatAgoSeconds),
      templateAgoSeconds: round(minerReading.templateAgoSeconds),
      active: isActive(minerReading.state),
    },
    // Refill loop state. spendableTaz uses this request's balance read (fresher
    // than the reconciler's last tick); refilling is the reconciler's decision.
    reserve: { ...getReserveReconciler().status, spendableTaz: balanceTaz },
  });
});
