/**
 * Ledger public API. Backend (local SQLite vs Cloudflare D1) is chosen by
 * config; callers just await reserveClaim / finalizeClaim.
 */
import { config } from "../config";
import { SqliteDriver, D1Driver, type DbDriver } from "./driver";
import {
  RESERVE_SQL,
  reserveParams,
  LIVE_BLOCK_SQL,
  FINALIZE_SQL,
  PENDING_LEASE_SECONDS,
} from "./sql";

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
  address: string,
  ipHash: string | null,
  now: number,
  cooldownSeconds: number,
): Promise<ReserveResult & { ok: false }> {
  const keys: [("address" | "ip_hash"), string, string][] = [["address", address, "address"]];
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

/** Atomically enforce cooldown + daily cap and reserve a pending claim. */
export async function reserveClaim(opts: {
  address: string;
  ipHash: string | null;
  amountZat: bigint;
  now: number;
  cooldownSeconds: number;
  dailyCapZat: bigint;
}): Promise<ReserveResult> {
  const ipHash = opts.ipHash ?? "";
  const res = await driver().run(
    RESERVE_SQL,
    reserveParams({
      address: opts.address,
      ipHash,
      amountZat: Number(opts.amountZat),
      now: opts.now,
      cooldownSeconds: opts.cooldownSeconds,
      dailyCapZat: Number(opts.dailyCapZat),
    }),
  );

  if (res.changes === 1) return { ok: true, claimId: res.lastInsertRowid };
  return whyBlocked(opts.address, opts.ipHash, opts.now, opts.cooldownSeconds);
}

/** Finalise a reserved claim once the send resolves. */
export async function finalizeClaim(claimId: number, status: "sent" | "failed", txid: string | null) {
  await driver().run(FINALIZE_SQL, [status, txid ?? "", claimId]);
}
