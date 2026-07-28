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
import { withApi, apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi("pow-challenge", async (req: NextRequest, api) => {
  if (config.challenge !== "pow") {
    return apiError(404, "PoW challenge is not enabled.", api);
  }
  const raw = clientIp(req);
  const ipHash = raw ? fingerprintIp(raw) : "anon";
  return NextResponse.json({ ok: true, ...issueChallenge(ipHash) });
});
