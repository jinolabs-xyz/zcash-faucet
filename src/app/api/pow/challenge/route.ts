/**
 * GET /api/pow/challenge — hand out a signed proof-of-work challenge.
 * The browser solves it (see the PoW worker) and returns it with the claim.
 * Difficulty adapts to the client's recent request rate and overall faucet load.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { clientIp } from "@/lib/clientIp";
import { fingerprintIp, fingerprintSubnet } from "@/lib/privacy";
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
  // Escalation keys on the range as well as the address (#196), so rotating IPs in a
  // cloud /24 cannot reset difficulty. Null on an unparseable IP, which skips the rule
  // rather than dropping every such client into one shared bucket.
  const subnetHash = raw ? fingerprintSubnet(raw) : null;
  return NextResponse.json({ ok: true, ...issueChallenge(ipHash, subnetHash) });
});
