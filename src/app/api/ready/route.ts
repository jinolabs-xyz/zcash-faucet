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
import { ledgerHealth } from "@/lib/db";
import { ledgerBlocksServing } from "@/lib/db/probe";
import { withApi } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi("ready", async () => {
  const [backend, balanceZat, node, ledger] = await Promise.all([
    pingBackend(),
    safeBalance(),
    getNodeStatus(),
    ledgerHealth(),
  ]);

  // Order the checks cheapest-signal first so the reason is the most upstream cause.
  // "frozen" comes before "syncing" and is deliberately distinct: syncing is a
  // normal first-boot state, but frozen means our node stopped following the
  // chain while the network moved on (#170) — the silent failure that took down
  // Fauzec's faucet. It must page, not look like an ordinary sync.
  //
  // The ledger goes FIRST, and it is the newest of these checks (#217). Measured on
  // 2026-07-30 with a ledger present but not a database: health, ready and status
  // all returned 200 with ready:true while every claim returned 500. Nothing the
  // watchdog could reach asked the one component every claim depends on, so a
  // zombie passed every check and an operator would have been sent to look at
  // docker, which shows everything running.
  //
  // First because it is the only check needing no network at all, so it is both the
  // cheapest signal and the most upstream cause: if the ledger cannot answer,
  // nothing else in this response changes what an operator has to go and fix, and
  // the fix is a disk rather than a chain.
  //
  // Only a DEFINITE failure blocks, via ledgerBlocksServing. A ledger that did not
  // answer in time is "unknown" and deliberately does NOT 503: this endpoint is
  // what the watchdog pages on and what redeploy rolls back on, so letting an
  // absent answer trip it hands a blip the power to roll back a good deploy. That
  // outage-amplifier is a bug this project has already paid for once.
  let reason: string | null = null;
  if (ledgerBlocksServing(ledger)) reason = "ledger unreadable";
  else if (!backend.reachable) reason = "backend unreachable";
  else if (node && node.frozen) reason = "node frozen behind network";
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
      // Reported even when serving, and carrying its own three-state verdict, so
      // "container up but not serving" has a name in the alert. "The faucet is
      // down" would point an operator at docker, which shows a healthy container.
      ledger,
      balanceTaz,
      ts: Math.floor(Date.now() / 1000),
    },
    { status: ready ? 200 : 503 },
  );
});
