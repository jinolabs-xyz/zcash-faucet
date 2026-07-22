/**
 * POST /api/faucet — the drip endpoint.
 * Order matters: cheap rejects first, expensive send last.
 *   1. parse + validate address
 *   2. verify Turnstile (anti-bot)
 *   3. rate-limit + daily-cap
 *   4. send + record
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { validateTestnetAddress } from "@/lib/zcash/address";
import { verifyTurnstile } from "@/lib/turnstile";
import { checkLimits } from "@/lib/rateLimit";
import { getSender, safeBalance } from "@/lib/zcash/send";
import { recordClaim } from "@/lib/db";
import { fingerprintIp } from "@/lib/privacy";

export const runtime = "nodejs"; // better-sqlite3 needs Node, not Edge.

const BodySchema = z.object({
  address: z.string().min(1).max(512),
  turnstileToken: z.string().optional(),
});

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "0.0.0.0";
}

export async function POST(req: NextRequest) {
  const now = Math.floor(Date.now() / 1000);
  // Raw IP stays local (only handed to Turnstile, which Cloudflare sees anyway).
  // Everything we persist uses the salted fingerprint instead.
  const rawIp = clientIp(req);
  const ipHash = fingerprintIp(rawIp);

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
  const human = await verifyTurnstile(body.turnstileToken, rawIp);
  if (!human) {
    return NextResponse.json({ ok: false, error: "Captcha verification failed." }, { status: 403 });
  }

  // 3. Rate limit
  const limit = checkLimits(address, ipHash, now);
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: limit.reason, retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 },
    );
  }

  // 4. Low-balance guard — protect the single hot wallet from being drained
  //    below its reserve floor. `null` means the backend can't report a balance
  //    yet (real sender not wired); we skip the guard and let send() surface it.
  const balance = await safeBalance();
  if (balance !== null && balance < config.dripZatoshi + config.minReserveZatoshi) {
    return NextResponse.json(
      { ok: false, error: "The faucet is empty right now. Please check back after it's refilled." },
      { status: 503 },
    );
  }

  // 5. Send
  try {
    const result = await getSender().send({
      toAddress: address,
      addressInfo: info,
      amountZat: config.dripZatoshi,
    });
    recordClaim({
      address,
      ipHash,
      amountZat: config.dripZatoshi,
      txid: result.txid,
      status: "sent",
      createdAt: now,
    });
    return NextResponse.json({
      ok: true,
      txid: result.txid,
      explorerUrl: result.explorerUrl,
      amountTaz: config.dripTaz,
      sender: config.sender,
      to: { kind: info.kind, shielded: info.shielded },
    });
  } catch (err) {
    recordClaim({
      address,
      ipHash,
      amountZat: config.dripZatoshi,
      txid: null,
      status: "failed",
      createdAt: now,
    });
    const message = err instanceof Error ? err.message : "Send failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
