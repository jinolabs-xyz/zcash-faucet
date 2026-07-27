/**
 * GET /api/pow/challenge — hand out a signed proof-of-work challenge.
 * The browser solves it (see the PoW worker) and returns it with the claim.
 * Difficulty adapts to the client's recent request rate and overall faucet load.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { clientIp } from "@/lib/clientIp";
import { fingerprintIp } from "@/lib/privacy";
import { issueChallenge } from "@/lib/pow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (config.challenge !== "pow") {
    return NextResponse.json({ ok: false, error: "PoW challenge is not enabled." }, { status: 404 });
  }
  const raw = clientIp(req);
  const ipHash = raw ? fingerprintIp(raw) : "anon";
  return NextResponse.json({ ok: true, ...issueChallenge(ipHash) });
}
