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

/**
 * The SUBNET an address belongs to, as a stable string. Grouping, not identifying.
 *
 * Why a coarser key at all (#196): addresses are free and unlimited, single IPs cost
 * money, and cloud IPs come in blocks. A farm shows up as many IPs inside a few
 * ranges. A residential claimer shows up as one IP in a range nobody else here is
 * using. The subnet is the cheapest thing that separates those two, and it costs an
 * honest claimer nothing.
 *
 * PRIVACY-POSITIVE rather than a cost. This is strictly LESS identifying than the
 * ip_hash we already keep: it deliberately cannot distinguish the 256 hosts in a /24,
 * so two people on the same block produce the same value. It sits alongside the IP
 * hash rather than replacing it only because the IP hash is what enforces the
 * per-person cooldown, which a subnet cannot.
 *
 * /24 for IPv4 and /64 for IPv6. The v6 choice matters: a single host is routinely
 * handed a whole /64 and may use any address inside it at will, so anything finer is
 * not a grouping, it is the same host wearing a different hat. /48 would group a whole
 * customer site and may prove the better boundary, but that is tuning and we have no
 * data yet, which is what #214 exists to produce.
 *
 * Returns null when the input will not parse, which SKIPS the subnet rule for that
 * request rather than inventing a key. A fallback bucket would put every unparseable
 * client into one shared group, and the first consequence would be real users blocking
 * each other. The per-IP cooldown still applies, so skipping loses one defence rather
 * than all of them.
 */
export function subnetOf(ip: string): string | null {
  const raw = ip.trim().toLowerCase();
  if (!raw) return null;

  // IPv4, including the IPv4-mapped form some proxies emit (::ffff:203.0.113.5).
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  if (!raw.includes(":")) return null;
  const groups = expandIpv6(raw);
  return groups === null ? null : `${groups.slice(0, 4).join(":")}::/64`;
}

/**
 * IPv6 to its eight hextets, normalised, or null if it is not one.
 *
 * Hand-rolled because the only property that matters here is that `2001:db8::1` and
 * `2001:0db8:0000:0000:0000:0000:0000:0001` yield the SAME subnet. A textual prefix
 * match would call those different networks, which is precisely the bug this avoids,
 * and it would let a farmer vary the written form to dodge the grouping.
 */
function expandIpv6(raw: string): string[] | null {
  const halves = raw.split("::");
  if (halves.length > 2) return null; // :: may appear at most once
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null; // no :: means all eight
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  // Strip leading zeros so a padded form cannot look like a different network.
  return groups.map((g) => g.replace(/^0+(?=.)/, ""));
}

/**
 * Fingerprint the subnet, or null when there is nothing to group by. Domain-separated
 * from the ip tag, so the same string cannot collide across the two columns.
 */
export function fingerprintSubnet(ip: string): string | null {
  const subnet = subnetOf(ip);
  return subnet === null ? null : fingerprint("subnet", subnet);
}
