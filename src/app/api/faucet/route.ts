/**
 * POST /api/faucet — the drip endpoint.
 * Order matters: cheap rejects first, expensive send last.
 *   1. parse + validate address
 *   2. anti-abuse gate (proof-of-work or Turnstile, per config)
 *   3. low-balance guard
 *   3.5 chain-freshness guard (a stale node builds transactions that cannot confirm)
 *   4. atomically reserve the claim (cooldown + daily cap, concurrency-safe)
 *   5. send, then finalise the reservation
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { validateTestnetAddress } from "@/lib/zcash/address";
import { verifyTurnstile } from "@/lib/turnstile";
import { verifySolution } from "@/lib/pow";
import { getSenderFor, safeBalance, SendOutcomeUnknownError, type SendResult } from "@/lib/zcash/send";
import { getNodeStatus } from "@/lib/zcash/nodeStatus";
import { mayBuildTransaction, readChainFreshnessAsking } from "@/lib/zcash/shieldGate";
import { getSendQueue, getCtazSendQueue, QueueFullError, TaskDeadlineError } from "@/lib/zcash/queue";
import { recordSend } from "@/lib/zcash/sendHealth";
import { DEFAULT_NETWORK, NETWORKS, parseNetwork } from "@/lib/network";
import { canServeCtaz } from "@/lib/crosslink/recency";
import { readCtazRecency } from "@/lib/crosslink/read";
import { reserveClaim, finalizeClaim } from "@/lib/db";
import { fingerprintIp, fingerprintSubnet } from "@/lib/privacy";
import { clientIp } from "@/lib/clientIp";
import { withApi, apiError } from "@/lib/api";

export const runtime = "nodejs"; // better-sqlite3 needs Node, not Edge.

// Roughly one testnet block. Long enough that a retry is not a hot loop, short
// enough that a lag of a few blocks clears within one or two retries.
const FRESHNESS_RETRY_SECONDS = 75;

const BodySchema = z.object({
  address: z.string().min(1).max(512),
  /**
   * Which chain to pay on (#326). OPTIONAL, and absent means TAZ: every client that
   * predates the toggle sends no network at all, and re-pointing those at anything
   * else would be changing what a request means without the caller knowing.
   *
   * Kept as a loose string here on purpose. `z.enum(["taz","ctaz"])` would answer a
   * bad value with the generic "Invalid request body", which is the same reply a
   * malformed address gets; parsing it below lets an unrecognised network say what
   * was actually wrong.
   */
  network: z.string().max(16).optional(),
  turnstileToken: z.string().optional(),
  pow: z
    .object({
      seed: z.string(),
      difficulty: z.number(),
      exp: z.number(),
      sig: z.string(),
      nonce: z.string(),
    })
    .optional(),
});

export const POST = withApi("faucet", async (req: NextRequest, api) => {
  const now = Math.floor(Date.now() / 1000);
  // Raw IP stays local (only handed to Turnstile, which Cloudflare sees anyway).
  // Everything we persist uses the salted fingerprint instead. null = we can't
  // trust an IP for this request, so the IP-based limit is skipped.
  const rawIp = clientIp(req);
  const ipHash = rawIp ? fingerprintIp(rawIp) : null;
  // Derived HERE because it needs the raw IP, and the ledger layer deliberately only
  // ever sees fingerprints. Null when the address will not parse, which skips the
  // subnet rule for this request rather than dropping the client into a shared bucket
  // with every other unparseable one (#196).
  const subnetHash = rawIp ? fingerprintSubnet(rawIp) : null;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return apiError(400, "Invalid request body.", api);
  }

  // 1. Address
  const info = validateTestnetAddress(body.address);
  if (!info.valid) {
    return apiError(400, info.reason ?? "Invalid address.", api);
  }
  const address = body.address.trim();

  // 1.5 Network. Absent is TAZ (a client older than the toggle); present-but-unknown
  //     is a 400, because a caller who named a network we do not serve must not be
  //     quietly paid on a different one. parseNetwork returns null for both, which is
  //     why the two cases are separated HERE rather than by a defaulting parser.
  const network = body.network === undefined ? DEFAULT_NETWORK : parseNetwork(body.network);
  if (network === null) {
    return apiError(400, `Unknown network. This faucet serves ${NETWORKS.join(" and ")}.`, api);
  }
  if (network === "ctaz" && !config.crosslink.enabled) {
    // 503 rather than 400: the request is well formed and will work on a deployment
    // with the flag on, so this is us not offering it rather than them asking wrongly.
    return apiError(503, "cTAZ is not enabled on this faucet.", api);
  }

  // Per-network policy. The cooldown is shared (a day is a day on either chain) but the
  // amount and the daily cap are not: cTAZ pays their fixed FAUCET_VALUE and draws on a
  // budget of its own. See RESERVE_SQL for which limits split and which stay global.
  const policy =
    network === "ctaz"
      ? { amountZat: config.crosslink.expectedZat, dailyCapZat: config.crosslink.dailyCapZatoshi }
      : { amountZat: config.dripZatoshi, dailyCapZat: config.dailyCapZatoshi };

  // 2. Anti-abuse gate — proof-of-work, Turnstile, or nothing, per config.
  //    PoW is verified against the same salted IP fingerprint the challenge was
  //    issued to, so a solution can't be reused from a different client.
  if (config.challenge === "pow") {
    if (!body.pow) {
      return apiError(403, "Proof of work required.", api);
    }
    const verdict = await verifySolution(body.pow, ipHash ?? "anon", subnetHash);
    if (!verdict.ok) {
      return apiError(403, verdict.reason ?? "Proof of work failed.", api);
    }
  } else if (config.challenge === "turnstile") {
    const human = await verifyTurnstile(body.turnstileToken, rawIp ?? undefined);
    if (!human) {
      return apiError(403, "Captcha verification failed.", api);
    }
  }

  // 3. Low-balance guard — protect the single hot wallet from being drained
  //    below its reserve floor. `null` means the backend can't report a balance
  //    yet (real sender not wired); we skip the guard and let send() surface it.
  //
  //    TAZ ONLY, and this is not a shortcut. safeBalance() reads OUR wallet through
  //    getSender(), and cTAZ is paid out of the Crosslink node's own mining wallet.
  //    Left unscoped, an empty TAZ wallet would refuse cTAZ claims for a shortage on
  //    a different chain, and a full one would vouch for a balance nobody read.
  if (network === "taz") {
    const balance = await safeBalance();
    if (balance !== null && balance < config.dripZatoshi + config.minReserveZatoshi) {
      return apiError(503, "The faucet is empty right now. Please check back after it's refilled.", api);
    }
  }

  // 3.5. Chain freshness. A drip is a transaction: it gets an expiry height of
  //    tip+40, so if our node's view of the tip is stale the transaction is born
  //    expired and can never be mined at any fee. That is #172, and #187 is that
  //    the shield path refused while this one did not: at a lag of 40 the faucet
  //    declined to move its own money and still sent a user's, returning ok:true
  //    with a txid and an explorer link for a transaction already dead.
  //
  //    BEFORE the reservation, deliberately. A refusal here must not consume the
  //    cooldown or count toward the daily cap: the user did nothing wrong and our
  //    node's lag is not their fault. #132 is the precedent for what it costs to
  //    charge someone for our own condition. It sits next to the low-balance guard
  //    because it is the same kind of check, ours-not-yours, come back shortly.
  //
  //    Fails closed via mayBuildTransaction(), true only for "safe", so a tip we
  //    cannot verify refuses too. Never `state !== "unsafe"`.
  //
  //    Scoped to the zallet path, and not as a convenience. The hazard is OUR node's
  //    stale view being stamped onto the transaction: zallet asks its own node for
  //    the tip, so a lagging node produces a doomed expiry. The real sender reads
  //    the tip from lightwalletd instead (realsend.ts: expiryHeight = height + 40
  //    off getLatestBlock()), so our node's lag cannot reach it and this gate has
  //    nothing to say. If lightwalletd were itself lagging that path would have the
  //    same disease from a different source, which is a separate question and not
  //    one this check can answer.
  //
  //    Written as an explicit sender test rather than leaning on getNodeStatus()
  //    returning null off-zallet, because that null is indistinguishable from an
  //    unreachable wallet, and those two must not share an answer: one is "does not
  //    apply", the other is "cannot verify, so refuse".
  //
  //    AND TAZ ONLY, for the same reason as the balance guard one block up: this
  //    measures OUR node's tip, and cTAZ transactions are built by their node from
  //    their own view. The cTAZ equivalent is right below, and it is a different
  //    question answered by a different source, so it is a separate check rather than
  //    a widened one.
  const freshness =
    network === "taz" && config.sender === "zallet"
      ? await readChainFreshnessAsking((await getNodeStatus())?.nodeHeight ?? null)
      : null;
  if (freshness && !mayBuildTransaction(freshness)) {
    // A string, not an Error: logError only attaches a stack to a real Error, and
    // a synthesised one here would put ten frames of Next internals in the log for
    // an expected operational state. Still level=error, because a node too stale to
    // pay anyone is worth seeing, the same reasoning as the reserve loop's refusals.
    api.logError(
      `drip refused, chain view ${freshness.state} (lag ${freshness.lag ?? "unknown"}): ${freshness.reason}`,
      "chain freshness gate",
    );
    return apiError(
      503,
      "Our node is catching up with the network, so a drip sent right now would expire " +
        "before it could confirm. Nothing was claimed, your cooldown is untouched. Try again shortly.",
      api,
      { retryAfterSeconds: FRESHNESS_RETRY_SECONDS },
    );
  }

  // 3.6. cTAZ's readiness, which is a better primitive than anything the TAZ side has.
  //    Our node cannot tell us it has fallen behind, which is why the check above has
  //    to compare against an independent source. `get_tfl_recency_status` reports the
  //    node's own view of the finality layer, so a node that is behind says so in its
  //    own answer.
  //
  //    Fails CLOSED. canServeCtaz is true for "ready" alone, so a node we cannot read
  //    refuses, and cannot-verify never serves. Before the reservation, like every
  //    other ours-not-yours refusal: no cooldown consumed, nothing counted.
  if (network === "ctaz") {
    const reading = await readCtazRecency();
    if (!canServeCtaz(reading.state)) {
      api.logError(
        `cTAZ drip refused, crosslink node ${reading.state} ` +
          `(round lag ${reading.roundLag ?? "unknown"}, answer ${reading.ageSeconds ?? "unknown"}s old)`,
        "cTAZ readiness gate",
      );
      return apiError(
        503,
        "The Crosslink node is not current enough to hand out cTAZ right now. Nothing was " +
          "claimed and your cooldown is untouched. Try again shortly.",
        api,
        { retryAfterSeconds: FRESHNESS_RETRY_SECONDS },
      );
    }
  }

  // 4. Reserve atomically (cooldown + daily cap in one transaction). This is the
  //    concurrency gate: with N simultaneous requests from the same client, only
  //    one reservation succeeds — the rest are blocked before any coins move.
  const reservation = await reserveClaim({
    address,
    ipHash,
    subnetHash,
    amountZat: policy.amountZat,
    now,
    cooldownSeconds: config.cooldownSeconds,
    dailyCapZat: policy.dailyCapZat,
    subnetDailyMax: config.subnetDailyMax,
    network,
  });
  if (!reservation.ok) {
    // A subnet refusal is worth SAYING, and the other two are not. A cooldown is
    // ordinary and a global cap is visible in the reserve figures, but this is a new
    // rule whose threshold is a judgement rather than a measurement (#196), so the
    // only way to learn whether it ever lands on a real person is to log when it
    // fires. Pairs with the farming counts: many refusals with a low
    // claims-per-IP ratio would mean the cap is too tight, not that we caught a farm.
    if (reservation.kind === "subnet") {
      api.logError(
        `claim refused by the per-subnet daily cap (limit ${config.subnetDailyMax}). If this ` +
          "fires while claims-per-distinct-IP stays near 1, the cap is too tight rather than working.",
        "subnet cap",
      );
    }
    // 429 for both cooldown kinds and the subnet rule, because all three are "you,
    // later". 503 stays for the global cap, which is "the faucet, later".
    return apiError(reservation.kind === "cap" ? 503 : 429, reservation.reason, api, {
      retryAfterSeconds: reservation.retryAfterSeconds,
    });
  }

  // 5. Send through the serial FIFO queue — one transaction touches the single
  //    hot wallet at a time. The send and the ledger commit are separate try
  //    blocks on purpose: "nothing left the wallet" may only ever be said when
  //    the send itself failed.
  //    Resolved BEFORE the send and reused afterwards, so the sender that finalises the
  //    claim is provably the one that made it. Calling getSenderFor() a second time
  //    down there would re-resolve through config and could, in principle, answer
  //    differently from the one that moved the money.
  const sender = getSenderFor(network);
  const queue = network === "ctaz" ? getCtazSendQueue() : getSendQueue();
  let result: SendResult;
  try {
    result = await queue.run(
      () => sender.send({ toAddress: address, addressInfo: info, amountZat: policy.amountZat }),
      config.sendTaskDeadlineMs,
    );
  } catch (err) {
    // A submitted-but-unresolved send is NOT a failure. The wallet holds an
    // opid and may still broadcast, so releasing the claim would let the same
    // address get paid twice, and telling the user nothing moved would be a lie.
    //
    // TaskDeadlineError lands here for the same reason and NOT in the failure
    // branch below: the queue only stopped waiting, it did not stop the send
    // (#88). Treating it as a failure would release the claim while a live
    // transaction was still being built.
    if (err instanceof SendOutcomeUnknownError || err instanceof TaskDeadlineError) {
      // Record it as sent, which is the only safe assumption for a payout we
      // cannot observe. Leaving the row 'pending' looked like it held the
      // claim, but pending only blocks for PENDING_LEASE_SECONDS, and an
      // unknown outcome BY DEFINITION means the send outlived the poll window,
      // so the lease would expire and hand out a second drip (#51). Sent rows
      // block for the full cooldown and keep counting toward the daily cap.
      //
      // The opid goes in the txid column (write-only, forensic) so an operator
      // can reconcile against z_getoperationresult and flip this to 'failed' if
      // nothing actually went out. Erring toward not paying twice: the cost of
      // being wrong here is one user waiting out a cooldown for a drip they did
      // not get, against the faucet paying twice for one entitlement.
      //
      // A deadline has no opid to record, so it gets the "deadline" marker. Same
      // unknown: prefix family, so one query finds every claim an operator needs
      // to reconcile by hand.
      //
      // The marker goes in the txid column, so this path never needs the no-txid
      // exemption even on cTAZ: there IS something to record, it just is not a
      // transaction id. The network is still passed, because the drip counted here is
      // as real as any other and belongs in its own bucket.
      // NOT a failure for health purposes. The wallet holds an opid and may have
      // broadcast, so counting it against the money path would let a slow wallet trip
      // readiness and roll a good deploy back.
      recordSend("unknown");
      const marker = err instanceof SendOutcomeUnknownError ? `unknown:${err.opid}` : "unknown:deadline";
      try {
        await finalizeClaim(reservation.claimId, "sent", marker, undefined, Date.now(), network);
      } catch (finErr) {
        api.logError(finErr, `finalize(unknown) failed, claim ${reservation.claimId} will release on the lease`);
      }
      api.logError(err, `send outcome UNKNOWN (${marker}), claim ${reservation.claimId} held for the full cooldown`);
      return apiError(
        504,
        "Your drip was submitted but we lost track of it before it confirmed. Do not retry yet: if it went " +
          "through, the coins are on their way. Check the address in a few minutes.",
        api,
      );
    }

    // Everything else genuinely did not send. Release the reservation so the
    // user can retry immediately.
    //
    // Counted, because this is the only place in the app that knows a drip failed. A
    // 502 to one caller and a log line is not a signal anything can act on, which is
    // how a crash-looping wallet stays invisible behind a readiness probe that only
    // reads a balance.
    recordSend("failed");
    try {
      await finalizeClaim(reservation.claimId, "failed", null, undefined, Date.now(), network);
    } catch (finErr) {
      api.logError(finErr, "finalize(failed) after failed send");
    }
    if (err instanceof QueueFullError) {
      return apiError(503, err.message, api);
    }
    // The raw send error can carry wallet/RPC internals. Log it under the
    // request id, tell the user only what they need: nothing moved, retry.
    api.logError(err, "send failed");
    return apiError(502, "The send failed on our side. Nothing left the wallet. Try again in a moment.", api);
  }

  recordSend("ok");

  // The send is broadcast. If recording it fails, that is an operator problem
  // (the cooldown may not commit), never a reason to tell the user it failed.
  try {
    // Crosslink returns no transaction id, so its claims record NULL through the one
    // exemption that exists for it. DERIVED FROM THE SENDER THAT ACTUALLY PAID rather
    // than passed in, so no caller can claim the exemption for a network that does have
    // txids: the guard in finalizeClaim only protects what does not opt out.
    //
    // The sender decides the EXEMPTION and the request decides the BUCKET, and they are
    // read from different places on purpose. Deriving the bucket from the sender too
    // would mean a cTAZ claim that somehow reached a Zallet sender got counted as TAZ,
    // hiding the misrouting in a statistic instead of leaving it visible as a cTAZ row
    // with a txid. If these two ever disagree that is a finding, and it stays legible.
    const noTxid = sender.name === "crosslink";
    await finalizeClaim(
      reservation.claimId,
      "sent",
      result.txid ?? null,
      noTxid ? "network-has-no-txid" : undefined,
      Date.now(),
      network,
    );
  } catch (err) {
    api.logError(err, "finalize(sent) failed AFTER broadcast, cooldown may be unrecorded");
  }
  return NextResponse.json({
    ok: true,
    // Absent for cTAZ, and absent rather than empty: the page renders "no transaction
    // id" because this key is MISSING, never because it recognised the network. The
    // receipt reads what happened instead of predicting it from a table.
    txid: result.txid,
    explorerUrl: result.explorerUrl,
    // What we asked for, unchanged, so no existing client shifts meaning.
    amountTaz: config.dripTaz,
    // What the network ACTUALLY paid, when it says. Crosslink's amount is fixed and
    // ignores what we asked for, so its reply is the only authoritative figure.
    ...(result.amountZat != null ? { paidZat: result.amountZat.toString() } : {}),
    network,
    // The sender that PAID, not the configured one. Identical on TAZ ("zallet" and
    // "real" are both the sender's own name and config's word for it), and only
    // different on cTAZ, where config.sender would have reported "zallet" for a
    // transaction Zallet had nothing to do with.
    sender: sender.name,
    to: { kind: info.kind, shielded: info.shielded },
  });
});
