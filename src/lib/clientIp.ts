/**
 * Best-effort client IP for rate-limiting and the PoW challenge.
 *
 * X-Forwarded-For is client-writable: a request can arrive with any value
 * already in it, and each proxy *appends* the peer it saw. So only the rightmost
 * `trustedProxyCount` entries — the ones our own infra added — are trustworthy;
 * everything to the left is attacker-controlled. With no trusted proxy
 * configured we ignore the header entirely rather than trust a spoofable value.
 */
import type { NextRequest } from "next/server";
import { config } from "./config";

export function clientIp(req: NextRequest): string | null {
  const trusted = config.trustedProxyCount;
  if (trusted > 0) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
      const idx = hops.length - trusted;
      if (idx >= 0 && hops[idx]) return hops[idx];
    }
  }
  return null;
}
