/**
 * Privacy helpers. This is a Zcash tool — we don't hold onto raw user data.
 *
 * We rate-limit by IP, but we never *store* the IP. Instead we keep a salted
 * hash: enough to recognise "same client claimed 5 min ago", useless as a way
 * to reconstruct who that was. Set RATE_LIMIT_SALT to a random secret in prod so
 * the hashes aren't reversible via a precomputed table of the IPv4 space.
 */
import { createHash } from "node:crypto";

const SALT = process.env.RATE_LIMIT_SALT ?? "zcash-faucet-dev-salt-change-me";

/** One-way, salted fingerprint of a client IP for cooldown bookkeeping only. */
export function fingerprintIp(ip: string): string {
  return createHash("sha256").update(SALT).update("|").update(ip).digest("hex").slice(0, 32);
}
