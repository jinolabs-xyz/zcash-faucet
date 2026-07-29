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
import { getSender, safeBalance, SendOutcomeUnknownError, type SendResult } from "@/lib/zcash/send";
import { getNodeStatus } from "@/lib/zcash/nodeStatus";
import { mayBuildTransaction, readChainFreshnessAsking } from "@/lib/zcash/shieldGate";
import { getSendQueue, QueueFullError, TaskDeadlineError } from "@/lib/zcash/queue";
import { reserveClaim, finalizeClaim } from "@/lib/db";
import { fingerprintIp } from "@/lib/privacy";
import { clientIp } from "@/lib/clientIp";
import { withApi, apiError } from "@/lib/api";

export const runtime = "nodejs"; // better-sqlite3 needs Node, not Edge.

// Roughly one testnet block. Long enough that a retry is not a hot loop, short
// enough that a lag of a few blocks clears within one or two retries.
const FRESHNESS_RETRY_SECONDS = 75;

const BodySchema = z.object({
  address: z.string().min(1).max(512),
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

  // 2. Anti-abuse gate — proof-of-work, Turnstile, or nothing, per config.
  //    PoW is verified against the same salted IP fingerprint the challenge was
  //    issued to, so a solution can't be reused from a different client.
  if (config.challenge === "pow") {
    if (!body.pow) {
      return apiError(403, "Proof of work required.", api);
    }
    const verdict = await verifySolution(body.pow, ipHash ?? "anon");
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
  const balance = await safeBalance();
  if (balance !== null && balance < config.dripZatoshi + config.minReserveZatoshi) {
    return apiError(503, "The faucet is empty right now. Please check back after it's refilled.", api);
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
  const freshness =
    config.sender === "zallet"
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

  // 4. Reserve atomically (cooldown + daily cap in one transaction). This is the
  //    concurrency gate: with N simultaneous requests from the same client, only
  //    one reservation succeeds — the rest are blocked before any coins move.
  const reservation = await reserveClaim({
    address,
    ipHash,
    amountZat: config.dripZatoshi,
    now,
    cooldownSeconds: config.cooldownSeconds,
    dailyCapZat: config.dailyCapZatoshi,
  });
  if (!reservation.ok) {
    return apiError(reservation.kind === "cap" ? 503 : 429, reservation.reason, api, {
      retryAfterSeconds: reservation.retryAfterSeconds,
    });
  }

  // 5. Send through the serial FIFO queue — one transaction touches the single
  //    hot wallet at a time. The send and the ledger commit are separate try
  //    blocks on purpose: "nothing left the wallet" may only ever be said when
  //    the send itself failed.
  let result: SendResult;
  try {
    result = await getSendQueue().run(
      () => getSender().send({ toAddress: address, addressInfo: info, amountZat: config.dripZatoshi }),
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
      const marker = err instanceof SendOutcomeUnknownError ? `unknown:${err.opid}` : "unknown:deadline";
      try {
        await finalizeClaim(reservation.claimId, "sent", marker);
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
    try {
      await finalizeClaim(reservation.claimId, "failed", null);
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

  // The send is broadcast. If recording it fails, that is an operator problem
  // (the cooldown may not commit), never a reason to tell the user it failed.
  try {
    await finalizeClaim(reservation.claimId, "sent", result.txid);
  } catch (err) {
    api.logError(err, "finalize(sent) failed AFTER broadcast, cooldown may be unrecorded");
  }
  return NextResponse.json({
    ok: true,
    txid: result.txid,
    explorerUrl: result.explorerUrl,
    amountTaz: config.dripTaz,
    sender: config.sender,
    to: { kind: info.kind, shielded: info.shielded },
  });
});
