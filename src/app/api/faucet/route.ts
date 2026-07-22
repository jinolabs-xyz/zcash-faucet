/**
 * POST /api/faucet — the drip endpoint.
 * Order matters: cheap rejects first, expensive send last.
 *   1. parse + validate address
 *   2. verify Turnstile (anti-bot)
 *   3. low-balance guard
 *   4. atomically reserve the claim (cooldown + daily cap, concurrency-safe)
 *   5. send, then finalise the reservation
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { validateTestnetAddress } from "@/lib/zcash/address";
import { verifyTurnstile } from "@/lib/turnstile";
import { getSender, safeBalance } from "@/lib/zcash/send";
import { reserveClaim, finalizeClaim } from "@/lib/db";
import { fingerprintIp } from "@/lib/privacy";

export const runtime = "nodejs"; // better-sqlite3 needs Node, not Edge.

const BodySchema = z.object({
  address: z.string().min(1).max(512),
  turnstileToken: z.string().optional(),
});

/**
 * Best-effort client IP for rate-limiting.
 *
 * X-Forwarded-For is a client-writable header: a request can arrive with any
 * value already in it, and each proxy *appends* the peer it saw. So only the
 * rightmost `trustedProxyCount` entries — the ones our own infra added — are
 * trustworthy; everything to the left is attacker-controlled. Taking XFF[0]
 * (the old behaviour) let anyone rotate the header to dodge the per-IP cooldown.
 *
 * With no trusted proxy configured we ignore XFF entirely rather than trust a
 * spoofable value. IP limiting is only ever a secondary guard anyway — the
 * spoof-proof ceiling on total drain is FAUCET_DAILY_CAP_TAZ.
 */
function clientIp(req: NextRequest): string | null {
  const trusted = config.trustedProxyCount;
  if (trusted > 0) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const idx = hops.length - trusted; // the hop our outermost proxy recorded
      if (idx >= 0 && hops[idx]) return hops[idx];
    }
  }
  return null; // unidentifiable → skip the IP layer rather than trust a spoof
}

export async function POST(req: NextRequest) {
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
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  // 1. Address
  const info = validateTestnetAddress(body.address);
  if (!info.valid) {
    return NextResponse.json({ ok: false, error: info.reason }, { status: 400 });
  }
  const address = body.address.trim();

  // 2. Anti-bot
  const human = await verifyTurnstile(body.turnstileToken, rawIp ?? undefined);
  if (!human) {
    return NextResponse.json({ ok: false, error: "Captcha verification failed." }, { status: 403 });
  }

  // 3. Low-balance guard — protect the single hot wallet from being drained
  //    below its reserve floor. `null` means the backend can't report a balance
  //    yet (real sender not wired); we skip the guard and let send() surface it.
  const balance = await safeBalance();
  if (balance !== null && balance < config.dripZatoshi + config.minReserveZatoshi) {
    return NextResponse.json(
      { ok: false, error: "The faucet is empty right now. Please check back after it's refilled." },
      { status: 503 },
    );
  }

  // 4. Reserve atomically (cooldown + daily cap in one transaction). This is the
  //    concurrency gate: with N simultaneous requests from the same client, only
  //    one reservation succeeds — the rest are blocked before any coins move.
  const reservation = reserveClaim({
    address,
    ipHash,
    amountZat: config.dripZatoshi,
    now,
    cooldownSeconds: config.cooldownSeconds,
    dailyCapZat: config.dailyCapZatoshi,
  });
  if (!reservation.ok) {
    return NextResponse.json(
      { ok: false, error: reservation.reason, retryAfterSeconds: reservation.retryAfterSeconds },
      { status: reservation.kind === "cap" ? 503 : 429 },
    );
  }

  // 5. Send, then finalise the reservation ('sent' commits the cooldown;
  //    'failed' releases it so the user can retry without waiting).
  try {
    const result = await getSender().send({
      toAddress: address,
      addressInfo: info,
      amountZat: config.dripZatoshi,
    });
    finalizeClaim(reservation.claimId, "sent", result.txid);
    return NextResponse.json({
      ok: true,
      txid: result.txid,
      explorerUrl: result.explorerUrl,
      amountTaz: config.dripTaz,
      sender: config.sender,
      to: { kind: info.kind, shielded: info.shielded },
    });
  } catch (err) {
    finalizeClaim(reservation.claimId, "failed", null);
    const message = err instanceof Error ? err.message : "Send failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
