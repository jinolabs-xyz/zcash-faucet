/**
 * Ledger public API. Backend (local SQLite vs Cloudflare D1) is chosen by
 * config; callers just await reserveClaim / finalizeClaim.
 *
 * The ledger never stores plaintext addresses or IPs — only salted fingerprints
 * (see lib/privacy.ts) — and it purges rows past the retention window, so it
 * holds the minimum needed to enforce cooldowns and nothing more.
 */
import { config } from "../config.ts";
import { fingerprintAddress } from "../privacy.ts";
import { SqliteDriver, D1Driver, type DbDriver } from "./driver.ts";
import {
  RESERVE_SQL,
  reserveParams,
  LIVE_BLOCK_SQL,
  FINALIZE_SQL,
  PURGE_SQL,
  PENDING_LEASE_SECONDS,
  SPEND_CHALLENGE_SQL,
  PURGE_CHALLENGES_SQL,
} from "./sql.ts";

const g = globalThis as unknown as { __faucetDriver?: DbDriver };
function driver(): DbDriver {
  return (g.__faucetDriver ??=
    config.dbBackend === "d1" ? new D1Driver(config.d1ProxyUrl, config.d1ProxySecret) : new SqliteDriver());
}

export type ReserveResult =
  | { ok: true; claimId: number }
  | { ok: false; kind: "cooldown" | "cap"; reason: string; retryAfterSeconds?: number };

/** Diagnose why an atomic reserve inserted 0 rows (for a useful error message). */
async function whyBlocked(
  addressHash: string,
  ipHash: string | null,
  now: number,
  cooldownSeconds: number,
): Promise<ReserveResult & { ok: false }> {
  const keys: [("address_hash" | "ip_hash"), string, string][] = [["address_hash", addressHash, "address"]];
  if (ipHash) keys.push(["ip_hash", ipHash, "client"]);

  for (const [col, val, label] of keys) {
    const row = await driver().get<{ created_at: number; status: string }>(LIVE_BLOCK_SQL(col), [
      val,
      now - cooldownSeconds,
      now - PENDING_LEASE_SECONDS,
    ]);
    if (row) {
      const window = row.status === "sent" ? cooldownSeconds : PENDING_LEASE_SECONDS;
      return {
        ok: false,
        kind: "cooldown",
        reason: `This ${label} already claimed recently. Try again later.`,
        retryAfterSeconds: Math.max(1, window - (now - row.created_at)),
      };
    }
  }
  // No live cooldown row → it was the daily cap.
  return { ok: false, kind: "cap", reason: "Faucet daily cap reached. Please come back tomorrow." };
}

/** Rows older than this can't affect a cooldown or the 24h cap — safe to delete. */
function retentionCutoff(now: number, cooldownSeconds: number): number {
  return now - Math.max(cooldownSeconds, 86_400) - 3_600; // +1h grace
}

/** Atomically enforce cooldown + daily cap and reserve a pending claim. */
export async function reserveClaim(opts: {
  address: string;
  ipHash: string | null;
  amountZat: bigint;
  now: number;
  cooldownSeconds: number;
  dailyCapZat: bigint;
}): Promise<ReserveResult> {
  const addressHash = fingerprintAddress(opts.address);
  const ipHash = opts.ipHash ?? "";

  // Data minimization: drop expired rows opportunistically (best-effort).
  driver()
    .run(PURGE_SQL, [retentionCutoff(opts.now, opts.cooldownSeconds)])
    .catch(() => {});

  const res = await driver().run(
    RESERVE_SQL,
    reserveParams({
      addressHash,
      ipHash,
      amountZat: Number(opts.amountZat),
      now: opts.now,
      cooldownSeconds: opts.cooldownSeconds,
      dailyCapZat: Number(opts.dailyCapZat),
    }),
  );

  if (res.changes === 1) return { ok: true, claimId: res.lastInsertRowid };
  return whyBlocked(addressHash, opts.ipHash, opts.now, opts.cooldownSeconds);
}

/** Finalise a reserved claim once the send resolves. */
export async function finalizeClaim(claimId: number, status: "sent" | "failed", txid: string | null) {
  await driver().run(FINALIZE_SQL, [status, txid ?? "", claimId]);
}

/**
 * Spend a proof-of-work challenge. Returns true if this caller got it, false if
 * it was already spent. In the ledger rather than in memory because the web
 * process restarts (watchdog, every deploy) and an in-memory set would silently
 * un-spend every live challenge inside its TTL.
 *
 * Prunes expired rows opportunistically, same best-effort pattern as the claim
 * purge, so the table cannot grow without bound.
 */
export async function spendChallenge(sig: string, exp: number, now: number): Promise<boolean> {
  driver().run(PURGE_CHALLENGES_SQL, [now]).catch(() => {});
  const res = await driver().run(SPEND_CHALLENGE_SQL, [sig, exp]);
  return res.changes === 1;
}
