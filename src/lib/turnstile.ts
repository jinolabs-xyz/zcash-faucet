/**
 * Cloudflare Turnstile server-side verification (siteverify).
 * If no secret key is configured, verification is skipped (dev convenience).
 */
import { config } from "./config";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token: string | undefined, ip?: string): Promise<boolean> {
  if (!config.turnstile.enabled) return true; // disabled in dev
  if (!token) return false;

  const body = new URLSearchParams({
    secret: config.turnstile.secretKey,
    response: token,
  });
  if (ip) body.set("remoteip", ip); // optional; only include when we have one

  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    const data = (await res.json()) as { success: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
