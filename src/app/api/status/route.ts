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
import { cachedCtazNodeState } from "@/lib/crosslink/cache";
import { canServeCtaz } from "@/lib/crosslink/recency";
import { withApi } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whole seconds on the wire. Null stays null: an age we do not have is not zero. */
const round = (n: number | null) => (n == null ? null : Math.round(n));

/**
 * The cTAZ half of the status (#326).
 *
 * A BLOCK OF ITS OWN rather than per-network variants of the keys above, so everything
 * at the top level keeps meaning TAZ exactly as it did before the toggle existed. A
 * page built against the old shape is not silently re-pointed at a different chain,
 * which is the failure mode that makes shared-surface changes expensive.
 *
 * `reserve` is the literal string "unknown", not null and not 0. Their RPC surface has
 * no shielded balance method at all, so this is an ANSWER, not a missing field, and it
 * has to survive the trip as one. A zero would say the wallet is empty; a null would
 * let a `?? 0` downstream turn it into one. Same reasoning that put the throw in
 * CrosslinkSender.balance instead of a return.
 */
async function ctazBlock() {
  if (!config.crosslink.enabled) return { enabled: false as const };
  // From the cache, never the socket: the node's RPC latency is bimodal (20ms or 30s)
  // and a status endpoint that sometimes takes half a minute is down in every way that
  // matters. cache.ts owns the expensive read and its staleness rules.
  const [node, drips] = await Promise.all([
    Promise.resolve(cachedCtazNodeState()),
    countDrips(Date.now(), "ctaz"),
  ]);
  const reading = node.reading;
  return {
    enabled: true as const,
    // Five states, not a boolean. "cannot-verify" is not "behind" and neither is "off".
    readiness: reading.state,
    // Both questions, per #322. The panel still shows state and percent apart.
    servable: canServeCtaz(reading.state, node.blocks ?? reading.height, node.tip, node.source),
    height: reading.height,
    roundLag: reading.roundLag,
    finalizers: reading.finalizers,
    ageSeconds: reading.ageSeconds,
    // SYNC PROGRESS, BESIDE THE VERDICT AND NEVER INSIDE IT (#322). The five states answer
    // "can we serve", and a syncing node cannot, so there is no syncing state by design.
    // A percent folded into a readiness verdict is how "23% synced" and "cannot reach the
    // node" end up rendering the same. Null when either side of the ratio was missing:
    // 0% would say barely-started about a node that may be at tip.
    syncPercent: node.syncPercent,
    blocks: node.blocks,
    tip: node.tip,
    // Which half is broken when something is. A stale writer and an unreachable node are
    // different fixes and the panel must not blame the node for the script.
    source: node.source,
    dripZat: config.crosslink.expectedZat.toString(),
    drips,
    reserve: "unknown" as const,
  };
}

export const GET = withApi("status", async () => {
  const [backend, balanceZat, node] = await Promise.all([pingBackend(), safeBalance(), getNodeStatus()]);
  // Synchronous and off the await chain: a few hundred bytes from a bind mount, so it
  // does not belong in the Promise.all with three network calls.
  const minerReading = readMinerHeartbeat(config.miner.heartbeatPath);

  const balanceTaz = balanceZat === null ? null : Number(balanceZat) / Number(ZATOSHI_PER_TAZ);
  const empty =
    balanceZat !== null && balanceZat < config.dripZatoshi + config.minReserveZatoshi;

  return NextResponse.json({
    // Which commit this running build came from, so an external check can tell whether a
    // merge actually reached production. The deploy is pull-based, so a stalled timer or a
    // silently failed rebuild otherwise looks identical to being up to date.
    // "unknown" when the deploy did not supply one, never omitted.
    buildCommit: process.env.FAUCET_BUILD_COMMIT || "unknown",
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
    drips: await countDrips(Date.now(), "taz"),
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
    ctaz: await ctazBlock(),
  });
});
