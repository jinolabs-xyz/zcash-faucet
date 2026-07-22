/**
 * Privacy helpers. This is a Zcash tool — data minimization is the whole point,
 * so we don't retain raw user data. Two things get fingerprinted, never stored
 * in the clear:
 *
 *  - the client IP (for cooldowns) — we never want to know who someone is.
 *  - the recipient ADDRESS (for cooldowns) — critically, storing a shielded
 *    recipient's address in plaintext would deanonymize them in a way the chain
 *    itself does not (an Orchard output reveals no recipient on-chain). So we
 *    keep only a salted hash: enough to recognise "this address claimed
 *    recently", useless as a record of who got funded.
 *
 * Set RATE_LIMIT_SALT to a long random secret in prod so the fingerprints
 * aren't reversible via a precomputed table.
 */
import { createHash } from "node:crypto";

const SALT = process.env.RATE_LIMIT_SALT ?? "zcash-faucet-dev-salt-change-me";

/** One-way, salted fingerprint, truncated to 128 bits. Domain-separated by tag. */
function fingerprint(tag: string, value: string): string {
  return createHash("sha256").update(SALT).update("|").update(tag).update("|").update(value).digest("hex").slice(0, 32);
}

/** Fingerprint a client IP for cooldown bookkeeping only. */
export function fingerprintIp(ip: string): string {
  return fingerprint("ip", ip);
}

/** Fingerprint a recipient address — we never store the plaintext address. */
export function fingerprintAddress(address: string): string {
  return fingerprint("addr", address.trim());
}
