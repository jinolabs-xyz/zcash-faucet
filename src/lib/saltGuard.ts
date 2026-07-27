/**
 * Boot guard for RATE_LIMIT_SALT. The PoW gate signs challenges with
 * HMAC(RATE_LIMIT_SALT), so serving production traffic with an empty or
 * template-placeholder salt means anyone who reads our deploy templates can
 * forge valid challenges and walk through the gate. Better a faucet that
 * refuses to start than one with a decorative lock.
 *
 * Pure function in the decide.ts mold so the rules are unit-testable without
 * reloading config. Only production with an active challenge gate is guarded.
 * Local dev and challenge=none run fine saltless.
 */

// Every placeholder our templates ship: deploy.sh writes __FILL_ME__, the z3
// and root env examples use the change-me variants. The substring check also
// catches hand-edited leftovers like "change-me-please".
const PLACEHOLDER_MARKERS = ["__fill_me__", "change-me", "changeme"];

export function saltRejectionReason(opts: {
  salt: string;
  production: boolean;
  challenge: string;
}): string | null {
  if (!opts.production) return null;
  if (opts.challenge !== "pow" && opts.challenge !== "turnstile") return null;

  const salt = opts.salt.trim();
  if (!salt) {
    return (
      "RATE_LIMIT_SALT is not set. The anti-abuse gate signs challenges with it, " +
      "so an empty salt makes the gate forgeable. Set a long random secret " +
      "(e.g. `openssl rand -hex 32`) and restart."
    );
  }
  const lower = salt.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((m) => lower.includes(m))) {
    return (
      `RATE_LIMIT_SALT is still the template placeholder ("${salt}"). Anyone who has ` +
      "read the deploy templates can forge anti-abuse challenges with it. Set a long " +
      "random secret (e.g. `openssl rand -hex 32`) and restart."
    );
  }
  return null;
}
