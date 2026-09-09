/**
 * Cloudflare Turnstile server-side verification (siteverify).
 *
 * THE SERVER HALF OF A MODE THIS FAUCET DOES NOT SERVE, AND DOES NOT PLAN TO. No page
 * renders the widget and no claim body carries a token, so assertServingConfig() refuses
 * FAUCET_CHALLENGE=turnstile at boot and the claim route has no branch for it. Kept
 * because it is small, tested and fails closed, not as a promise; delete it the day it
 * costs anything. Do not read its presence as the mode working.
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
  /** Called for a failure that is OURS (transport, timeout, non-2xx, a body of the wrong
   *  shape), never for a token Cloudflare simply refused. */
  onFailure?: (why: string) => void;
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
    if (!res.ok) {
      c.onFailure?.(`siteverify answered HTTP ${res.status}`);
      return false;
    }
    const data: unknown = await res.json();
    if (typeof data === "object" && data !== null && (data as { success?: unknown }).success === true) return true;
    // A refused token is the user's problem and expected traffic; only the shape of the
    // answer is ours to notice.
    if (typeof data !== "object" || data === null || !("success" in data)) c.onFailure?.("siteverify body had no success field");
    return false;
  } catch (e) {
    // "We could not look" must not print the same as "nobody claimed": the user sees a 403
    // either way, and this is the only place an operator can see that Cloudflare, DNS or
    // the 5 s bound was the cause and not the token.
    c.onFailure?.(`siteverify unreachable: ${e instanceof Error ? e.name + (e.message ? `: ${e.message}` : "") : String(e)}`);
    return false;
  }
}

export function verifyTurnstile(token: string | undefined, ip?: string): Promise<boolean> {
  return verifyTurnstileWith(fetch, {
    enabled: config.turnstile.enabled,
    secretKey: config.turnstile.secretKey,
    token,
    ip,
    onFailure: (why) => console.error(`[turnstile] refusing the claim because ${why}; the user sees a captcha failure`),
  });
}
