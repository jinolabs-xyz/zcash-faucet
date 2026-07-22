/**
 * Rate-limit + daily-cap checks, all backed by the claims table.
 * Enforced BEFORE we attempt a send so we never broadcast for an abuser.
 */
import { db } from "./db";
import { config } from "./config";

export interface LimitResult {
  ok: boolean;
  reason?: string;
  retryAfterSeconds?: number;
}

/** Most recent successful claim timestamp for a given column value. */
function lastClaimAt(column: "address" | "ip_hash", value: string): number | null {
  const row = db
    .prepare(
      `SELECT created_at FROM claims
       WHERE ${column} = ? AND status = 'sent'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(value) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}

export function checkLimits(address: string, ipHash: string | null, now: number): LimitResult {
  const { cooldownSeconds, dailyCapZatoshi } = config;

  const checks: [("address" | "ip_hash"), string, string][] = [["address", address, "address"]];
  // Only rate-limit by IP when we actually trust one (see clientIp in the route).
  if (ipHash) checks.push(["ip_hash", ipHash, "client"]);

  for (const [column, value, label] of checks) {
    const last = lastClaimAt(column, value);
    if (last !== null) {
      const elapsed = now - last;
      if (elapsed < cooldownSeconds) {
        return {
          ok: false,
          reason: `This ${label} already claimed recently. Try again later.`,
          retryAfterSeconds: cooldownSeconds - elapsed,
        };
      }
    }
  }

  // Global daily cap (safety valve against a drained faucet).
  const since = now - 86_400;
  const dispensed = db
    .prepare(
      `SELECT COALESCE(SUM(amount_zat), 0) AS total FROM claims
       WHERE status = 'sent' AND created_at >= ?`,
    )
    .get(since) as { total: number };
  if (BigInt(dispensed.total) + config.dripZatoshi > dailyCapZatoshi) {
    return { ok: false, reason: "Faucet daily cap reached. Please come back tomorrow." };
  }

  return { ok: true };
}
