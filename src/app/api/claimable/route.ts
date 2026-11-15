/**
 * POST /api/claimable - would this address be refused for a reason of its own?
 *
 * Asked by the page BEFORE the proof-of-work. Without it a reused address solved the
 * puzzle (~26s on a laptop) and then waited on the wallet reads in /api/faucet (~10s)
 * to hear "already claimed" - 36s measured on prod 2026-11-12, for an answer the
 * ledger has in one read.
 *
 * Same body as /api/faucet's 429 so the page renders both through one branch. No txid,
 * for the reason /api/faucet gives: an address-to-payment link is the record PRIVACY.md
 * refuses to build. What this does say without a puzzle - "this address claimed in the
 * last 24h" - is only learnable by someone who already holds the address.
 *
 * Advisory. /api/faucet's atomic reserve is still the gate, so a race between this and
 * the claim is refused there exactly as before.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { validateTestnetAddress } from "@/lib/zcash/address";
import { DEFAULT_NETWORK, parseNetwork } from "@/lib/network";
import { claimBlocker } from "@/lib/db";
import { fingerprintIp, fingerprintSubnet } from "@/lib/privacy";
import { clientIp } from "@/lib/clientIp";
import { withApi, apiError, notAllowed } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ address: z.string().max(512), network: z.string().optional() });

export const POST = withApi("claimable", async (req: NextRequest, api) => {
  const now = Math.floor(Date.now() / 1000);
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return apiError(400, "Invalid request body.", api, "badBody");
  }
  if (!validateTestnetAddress(body.address).valid) return apiError(400, "Invalid address.", api, "badAddress");
  const network = body.network === undefined ? DEFAULT_NETWORK : parseNetwork(body.network);
  if (network === null) return apiError(400, "Unknown network.", api, "badNetwork");

  const rawIp = clientIp(req);
  const block = await claimBlocker({
    address: body.address.trim(),
    ipHash: rawIp ? fingerprintIp(rawIp) : null,
    subnetHash: rawIp ? fingerprintSubnet(rawIp) : null,
    now,
    cooldownSeconds: config.cooldownSeconds,
    subnetDailyMax: config.subnetDailyMax,
    ipDailyMax: config.ipDailyMax,
    network,
  });
  if (!block) return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  // A clock time only for the measured cooldowns; the subnet's hour is a fixed guess (see /api/faucet).
  const nextAt =
    block.kind === "cooldown" && block.retryAfterSeconds != null
      ? new Date((now + block.retryAfterSeconds) * 1000).toISOString()
      : undefined;
  return apiError(429, block.reason, api, "cooldown", {
    kind: block.kind,
    ...(block.scope ? { scope: block.scope } : {}),
    retryAfterSeconds: block.retryAfterSeconds,
    ...(nextAt ? { nextAt } : {}),
  });
});
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
