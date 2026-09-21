/** GET /api/status - backend reachability, faucet policy, and wallet balance. */
import { NextRequest, NextResponse } from "next/server";
import { config, ZATOSHI_PER_TAZ } from "@/lib/config";
import { classifyIntegrity } from "@/lib/boxIntegrity";
import { publicBox } from "@/lib/boxLabel";
import { OPS_HEADER, opsTokenMatches } from "@/lib/opsToken";
import { readBoxIntegrity } from "@/lib/boxIntegrityFile";
import { pingBackend } from "@/lib/zcash/lightwalletd";
import { safeBalance } from "@/lib/zcash/send";
import { getCtazSendQueue, getSendQueue } from "@/lib/zcash/queue";
import { readSendHealth } from "@/lib/zcash/sendHealth";
import { countDrips } from "@/lib/db";
import { nodeStatusForPage } from "@/lib/zcash/nodeStatusCache";
import { getReserveReconciler } from "@/lib/reserve/reconciler";
import { readMinerHeartbeat } from "@/lib/miner/read";
import { isActive, publicMinerView } from "@/lib/miner/heartbeat";
import { cachedCtazNodeStateWarm } from "@/lib/crosslink/cache";
import { canServeCtaz } from "@/lib/crosslink/recency";
import { uptimeReading } from "@/lib/uptime";
import { minerRow } from "@/lib/minerLabel";
import { withApi, notAllowed } from "@/lib/api";

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
    cachedCtazNodeStateWarm(),
    countDrips(Date.now(), "ctaz"),
  ]);
  const reading = node.reading;
  return {
    enabled: true as const,
    // This wallet's own money-path verdict. It pays from a different balance than TAZ, so
    // one cannot stand in for the other and the page shows both.
    sends: readSendHealth(Date.now(), undefined, "ctaz"),
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

export const GET = withApi("status", async (req: NextRequest) => {
  // The operator's view (risk register II, R-24): the box's named faults and the
  // running commit come back only with the token; everyone else gets one word and no
  // commit. See src/lib/opsToken.ts.
  const ops = opsTokenMatches(req.headers.get(OPS_HEADER), process.env.FAUCET_OPS_TOKEN);
  const box = classifyIntegrity(readBoxIntegrity(), Date.now());
  // Two bodies on one URL, chosen by a header: say so to any cache that ever sits in
  // front, or the operator's body could be handed to the public. Caddy caches nothing
  // today; this is for the day something does.
  const headers = { "cache-control": "private, no-store", vary: OPS_HEADER };
  // "page", NOT the claim budget. A visitor who has just arrived is owed an answer quickly; a
  // status card that takes twelve seconds to fill reads as a broken site. The claim path is the
  // one that waits, because there a person pressed a button and expects work.
  // THE HEIGHT NO LONGER GATES THE REST. It used to sit in this Promise.all, so the slowest of the
  // three decided when the balance, the reserve, the miner and the drip count reached the visitor -
  // and measured on prod the page's read refused 11.27% of the time and had a tail to ~10s. It is
  // served from memory now and refreshed behind the response; see nodeStatusCache.ts.
  const [backend, balanceZat, node] = await Promise.all([pingBackend(), safeBalance(), nodeStatusForPage()]);
  // Synchronous and off the await chain: a few hundred bytes from a bind mount, so it
  // does not belong in the Promise.all with three network calls.
  const minerReading = readMinerHeartbeat(config.miner.heartbeatPath);
  // Split once, here, so the public projection is a THING rather than a habit: every
  // later use of publicMinerReading is incapable of carrying the operator half, and
  // minerOperator has exactly one consumer below, inside the ops branch.
  const publicMinerReading = publicMinerView(minerReading);
  const minerOperator = minerReading.operator;

  const balanceTaz = balanceZat === null ? null : Number(balanceZat) / Number(ZATOSHI_PER_TAZ);
  const empty =
    balanceZat !== null && balanceZat < config.dripZatoshi + config.minReserveZatoshi;

  // HOW LONG THIS PROCESS HAS BEEN UP, public. A restart is already inferable from a
  // health blip and from the merge times in a public repository, so a count of seconds
  // leaks nothing new - and it answers "did it restart" in one GET, which is the question
  // that cost an hour on 2026-09-15 when it was answered by reading another field's
  // counter without knowing its tick rate. The exact instant rides in the operator block.
  const uptime = uptimeReading(process.uptime(), Date.now());

  return NextResponse.json({
    // Which commit this running build came from, so an external check can tell whether a
    // merge actually reached production. The deploy is pull-based, so a stalled timer or a
    // silently failed rebuild otherwise looks identical to being up to date.
    // "unknown" when the deploy did not supply one. OPERATOR ONLY (R-24): to anyone
    // else "three commits behind main" is a list of fixes the box does not have yet.
    ...(ops ? { buildCommit: process.env.FAUCET_BUILD_COMMIT || "unknown", startedAt: uptime.startedAt } : {}),
    uptimeSeconds: uptime.uptimeSeconds,
    network: config.network,
    dripTaz: config.dripTaz,
    cooldownSeconds: config.cooldownSeconds,
    sender: config.sender,
    challenge: config.challenge, // "pow" | "none" in any process that serves; turnstile refuses to boot
    balanceTaz, // null = unknown (backend not ready / still syncing)
    empty,
    donationAddress: config.donationAddress,
    miningAddress: config.miningAddress,
    // Mainnet, for donations toward running the project. Validated in config, so
    // an empty string here means unset OR rejected, and the UI treats both the
    // same: show nothing rather than a doubtful address for real funds.
    maintenanceAddress: config.maintenanceAddress,
    // Both send queues: this is what redeploy.sh waits on before replacing the
    // container, and the in-process drain waits on the same sum (R-27).
    queueDepth: getSendQueue().depth + getCtazSendQueue().depth,
    // THE MONEY-PATH VERDICT, on the endpoint the page polls (risk register II, R-32).
    // /api/ready has carried it since #457 and nothing else read it: with every send
    // failing, ready answered 503 "3 of the last 3 sends failed" while this endpoint,
    // the badge and the claim button all said LIVE, and each visitor paid proof-of-work
    // into a wallet the faucet had already judged, at +2 bits per retry.
    // TAZ's wallet, named rather than defaulted: cTAZ reports its own below (#517).
    sends: readSendHealth(Date.now(), undefined, "taz"),
    // How many drips this faucet has served: ever, last 7 UTC days, last 30. From the
    // privacy-safe per-day counter, not the claims table, whose rows retention deletes.
    // Null when the ledger will not answer; an unknown count is not zero.
    drips: await countDrips(Date.now(), "taz"),
    backend,
    // Does the box have what the repo says it must? To the operator (token): counts,
    // never file names, plus the watchdog unit and pager state. To everyone else: one
    // word (R-24), because "the watchdog is stopped" and "pages go nowhere" on a public
    // page is reconnaissance. live-smoke asserts this from outside on a schedule with
    // the token, and it is the only signal that has ever reached us unprompted.
    // The operator's shape carries the same one-word verdict the public gets, so the
    // off-box probe judges both shapes by that word alone and never prints a unit or
    // bridge name into a run log that, on a public repository, anyone can read.
    box: ops ? { ...box, verdict: publicBox(box).state } : publicBox(box),
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
    // THE PUBLIC HALF, CARVED OFF EXPLICITLY. `...minerReading` publishes whatever the
    // reading carries, so reading a field and PUBLISHING it are one action - which is why
    // the operator half is a nested object rather than three more flat fields. Pulling it
    // out here means a leak needs someone to DELETE this line, not to forget one, and the
    // suite can assert a token-less response does not carry these keys.
    miner: {
      ...publicMinerReading,
      beatAgoSeconds: round(minerReading.beatAgoSeconds),
      templateAgoSeconds: round(minerReading.templateAgoSeconds),
      waitingAgoSeconds: round(minerReading.waitingAgoSeconds),
      active: isActive(minerReading.state),
      // THE MINER'S EXPLANATORY DETAIL, OPERATOR ONLY (#569). The redesign moved the public page
      // to one word and the template age, which is the standing rule working as intended - the
      // public surface says one word about ops state and never a fault name. That left the
      // sentences an operator acts on (what the heartbeat means, why it is parked, the acceptance
      // ratio, the last template age) on no page at all. They belong behind the token, beside the
      // box's named faults, for the same reason those are: `publicBoxRow` already tells the public
      // "detail is on the box, not here", and this is that detail.
      //
      // Rendered with the same minerRow() the unit tests cover rather than reshaped here, so the
      // wire format and the tested format cannot drift apart - the reason given twenty lines up
      // for sending the reading through as-is.
      //
      // THE SAME RULE, APPLIED TO THE NEW FIELDS (#666). lastRejectReason is a fixed token
      // and not the node's text - but a fixed token is still not a thing to publish, and
      // abandonedCount/abandonedAgoSeconds say how often the miner is losing races, which
      // is operator detail by the same standard as the rest of `detail`.
      // Nested under `operator`, mirroring the reading, so the wire format and the tested
      // format cannot drift apart - the reason given above for sending the rest through
      // as-is.
      ...(ops ? { detail: minerRow(minerReading, box.minerUnit), operator: minerOperator } : {}),
    },
    // Refill loop state. spendableTaz uses this request's balance read (fresher
    // than the reconciler's last tick); refilling is the reconciler's decision.
    reserve: { ...getReserveReconciler().status, spendableTaz: balanceTaz },
    ctaz: await ctazBlock(),
  }, { headers });
});
// Methods this route does not serve: labelled 405s, not the framework's silent one.
export const POST = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
