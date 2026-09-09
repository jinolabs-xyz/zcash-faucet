/**
 * GET /api/ready - readiness probe. Unlike /api/health (liveness: "is the web
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
import { cachedLedgerHealth } from "@/lib/db";
import { ledgerBlocksServing } from "@/lib/db/probe";
import { readSendHealth, sendHealthBlocksServing } from "@/lib/zcash/sendHealth";
import { readinessReason } from "@/lib/readiness";
import { withApi } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi("ready", async () => {
  const [backend, balanceZat, node] = await Promise.all([pingBackend(), safeBalance(), getNodeStatus()]);
  // SYNCHRONOUS and last-known, never awaited (#234). #228 awaited a real query
  // here, which put an IO call on the readiness critical path: the exact coupling
  // #171 removed from the tip oracle, on the endpoint the watchdog pages on and
  // redeploy rolls back on. A background timer keeps this fresh and staleness
  // degrades it to "unknown" rather than leaving a stale "ok" in place.
  const ledger = cachedLedgerHealth();

  // Order the checks cheapest-signal first so the reason is the most upstream cause.
  // "frozen" comes before "syncing" and is deliberately distinct: syncing is a
  // normal first-boot state, but frozen means our node stopped following the
  // chain while the network moved on (#170) - the silent failure that took down
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
  // What the last few drips actually DID, as opposed to what the probes above say we
  // could do. Every check in this list interrogates something ADJACENT to the money
  // path, and all of them can pass while send() throws on every call: reading a balance
  // and building a shielded transaction are different operations. A crash-looping
  // wallet is alive often enough for the balance read to land, so this endpoint said
  // 200 while claims 502'd, and nothing anywhere counted the failures.
  //
  // Same treatment as the ledger: only a DEFINITE verdict blocks. Too few sends to
  // judge is "unknown" and does not 503, or a quiet faucet would take itself down for
  // being quiet, and a slow one would hand a blip the power to roll back a deploy.
  const sends = readSendHealth();

  // THE SEND GATE, finally on the readiness path (risk register #7, 2026-09-08). Every
  // claim runs mayBuildTransaction() and refuses when our node's view of the chain is
  // stale, because a transaction stamped from a stale tip expires before it confirms.
  // This endpoint never asked, so a faucet refusing every drip answered 200 here, the
  // probe read healthy, nobody was paged, and the first signal was a forum post.
  //
  // The order and the one asymmetry live in readinessReason() with their tests: only
  // "unsafe" 503s; "unverifiable" keeps 200 because redeploy rolls back on this endpoint
  // and a public oracle's outage must not roll back a good deploy. The refusal still
  // rides in the body as node.canBuildTx, which the watchdog and the probe read.
  //
  // WHAT canBuildTx IS HERE: the gate's CACHED verdict, from the non-blocking oracle read
  // in getNodeStatus(). The claim path asks the oracle with a budget before deciding, so
  // readiness is the more pessimistic of the two: right after a restart the cache is cold
  // and this can say canBuildTx:false for a claim that would have succeeded. The pagers
  // absorb that with their grace and retries; nothing here should be read as "a claim
  // just now was refused".
  const reason = readinessReason({
    ledgerBlocks: ledgerBlocksServing(ledger),
    backendReachable: backend.reachable,
    node,
    balanceZat,
    sendsBlock: sendHealthBlocksServing(sends),
    sendsReason: sends.reason ?? null,
    floorZat: config.dripZatoshi + config.minReserveZatoshi,
    // getNodeStatus() returns null both when there is no node to ask and when the node
    // did not answer; only the first is fine, and this is how the verdict tells them apart.
    nodeExpected: config.sender === "zallet",
  });

  const ready = reason === null;
  const balanceTaz = balanceZat === null ? null : Number(balanceZat) / Number(ZATOSHI_PER_TAZ);

  return NextResponse.json(
    {
      ready,
      reason, // null when ready; otherwise the most upstream blocker
      // { ready, syncPercent, height, nodeHeight, shield, canBuildTx, ... } or null.
      // canBuildTx is the send gate's verdict; false with a 200 means "serving, but
      // refusing every drip because the tip cannot be verified". Readers that page
      // (watchdog step 4, scripts/live-probe.mjs) treat that as not ready.
      node,
      backend: { reachable: backend.reachable },
      // Reported even when serving, and carrying its own three-state verdict, so
      // "container up but not serving" has a name in the alert. "The faucet is
      // down" would point an operator at docker, which shows a healthy container.
      ledger,
      // Reported in EVERY response, including when ready, so an operator can see a
      // money path recovering or degrading before it crosses the threshold.
      sends,
      balanceTaz,
      ts: Math.floor(Date.now() / 1000),
    },
    { status: ready ? 200 : 503 },
  );
});
