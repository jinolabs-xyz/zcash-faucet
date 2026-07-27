/**
 * POST /api/faucet — the drip endpoint.
 * Order matters: cheap rejects first, expensive send last.
 *   1. parse + validate address
 *   2. anti-abuse gate (proof-of-work or Turnstile, per config)
 *   3. low-balance guard
 *   4. atomically reserve the claim (cooldown + daily cap, concurrency-safe)
 *   5. send, then finalise the reservation
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { validateTestnetAddress } from "@/lib/zcash/address";
import { verifyTurnstile } from "@/lib/turnstile";
import { verifySolution } from "@/lib/pow";
import { getSender, safeBalance, type SendResult } from "@/lib/zcash/send";
import { getSendQueue, QueueFullError } from "@/lib/zcash/queue";
import { reserveClaim, finalizeClaim } from "@/lib/db";
import { fingerprintIp } from "@/lib/privacy";
import { clientIp } from "@/lib/clientIp";
import { withApi, apiError } from "@/lib/api";

export const runtime = "nodejs"; // better-sqlite3 needs Node, not Edge.

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
    const verdict = verifySolution(body.pow, ipHash ?? "anon");
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
    result = await getSendQueue().run(() =>
      getSender().send({ toAddress: address, addressInfo: info, amountZat: config.dripZatoshi }),
    );
  } catch (err) {
    // Nothing moved. Release the reservation so the user can retry freely.
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
