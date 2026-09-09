/**
 * Cloudflare Turnstile server-side verification (siteverify).
 *
 * FAILS CLOSED. The first version returned true when no secret was configured, as a
 * dev convenience, which made FAUCET_CHALLENGE=turnstile with a missing key an open
 * faucet that looked gated (risk register #10). No secret now refuses every claim,
 * and assertServingConfig() refuses to boot in that state so nobody learns it from
 * the refusals. The siteverify call is bounded too: it sat on the money path with no
 * timeout, so a slow Cloudflare held a queue slot per claim for as long as it liked.
 */
import { config } from "./config.ts";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const SITEVERIFY_TIMEOUT_MS = 5000;

export type SiteverifyFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TurnstileCheck {
  enabled: boolean;
  secretKey: string;
  token: string | undefined;
  ip?: string;
  timeoutMs?: number;
}

/**
 * The verdict, with the transport injectable so every branch is reachable without
 * Cloudflare: disabled, no token, a slow answer, a non-2xx, a body that is not the
 * shape we expect. Anything but an explicit `success: true` is a refusal.
 */
export async function verifyTurnstileWith(fetchImpl: SiteverifyFetch, c: TurnstileCheck): Promise<boolean> {
  if (!c.enabled) return false;
  if (!c.token) return false;

  const body = new URLSearchParams({ secret: c.secretKey, response: c.token });
  if (c.ip) body.set("remoteip", c.ip); // optional; only include when we have one

  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(c.timeoutMs ?? SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data: unknown = await res.json();
    return typeof data === "object" && data !== null && (data as { success?: unknown }).success === true;
  } catch {
    return false;
  }
}

export function verifyTurnstile(token: string | undefined, ip?: string): Promise<boolean> {
  return verifyTurnstileWith(fetch, {
    enabled: config.turnstile.enabled,
    secretKey: config.turnstile.secretKey,
    token,
    ip,
  });
}
