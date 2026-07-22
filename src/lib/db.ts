/**
 * SQLite persistence + the atomic claim reservation that makes the faucet safe
 * under concurrency (target: several developers hitting it at once).
 *
 * The important bit: reserving a claim is a SINGLE synchronous transaction
 * (better-sqlite3 is synchronous, so Node can't interleave another request in
 * the middle of it). That closes the check-then-send race where N simultaneous
 * requests from the same address could all pass a naive cooldown check and
 * double-drip. A claim is inserted as 'pending' up front, then finalised to
 * 'sent' / 'failed' once the send resolves.
 *
 * Swap for Postgres by replacing this module if you ever scale past one node.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

// Reuse a single connection across hot reloads in dev.
const g = globalThis as unknown as { __faucetDb?: Database.Database };
export const db = g.__faucetDb ?? (g.__faucetDb = new Database(join(DATA_DIR, "faucet.db")));

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000"); // wait rather than throw if a write is in flight

// ip_hash is a salted fingerprint, never the raw IP — see lib/privacy.ts.
// status: 'pending' (reserved, send in flight) | 'sent' | 'failed'.
db.exec(`
  CREATE TABLE IF NOT EXISTS claims (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    address      TEXT    NOT NULL,
    ip_hash      TEXT    NOT NULL,
    amount_zat   INTEGER NOT NULL,
    txid         TEXT,
    status       TEXT    NOT NULL DEFAULT 'pending',
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_claims_address ON claims(address, created_at);
  CREATE INDEX IF NOT EXISTS idx_claims_iphash  ON claims(ip_hash, created_at);
  CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(created_at);
`);

// A 'pending' row that never finalises (e.g. server died mid-send) shouldn't
// lock a user out for the whole cooldown — it only blocks for this lease.
const PENDING_LEASE_SECONDS = 120;

export type ReserveResult =
  | { ok: true; claimId: number }
  | { ok: false; kind: "cooldown" | "cap"; reason: string; retryAfterSeconds?: number };

/** True if a live (sent-in-cooldown or pending-in-lease) claim exists for value. */
function liveClaimBlock(
  column: "address" | "ip_hash",
  value: string,
  now: number,
  cooldownSeconds: number,
): number | null {
  const sent = db
    .prepare(
      `SELECT created_at FROM claims
       WHERE ${column} = ? AND status = 'sent' AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(value, now - cooldownSeconds) as { created_at: number } | undefined;
  if (sent) return cooldownSeconds - (now - sent.created_at);

  const pending = db
    .prepare(
      `SELECT created_at FROM claims
       WHERE ${column} = ? AND status = 'pending' AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(value, now - PENDING_LEASE_SECONDS) as { created_at: number } | undefined;
  if (pending) return PENDING_LEASE_SECONDS - (now - pending.created_at);

  return null;
}

const reserveTxn = db.transaction(
  (o: {
    address: string;
    ipHash: string | null;
    amountZat: number;
    now: number;
    cooldownSeconds: number;
    dailyCapZat: number;
  }): ReserveResult => {
    // 1. cooldown — by address, and by client (when we have a trusted IP)
    const keys: [("address" | "ip_hash"), string, string][] = [["address", o.address, "address"]];
    if (o.ipHash) keys.push(["ip_hash", o.ipHash, "client"]);
    for (const [col, val, label] of keys) {
      const remaining = liveClaimBlock(col, val, o.now, o.cooldownSeconds);
      if (remaining !== null) {
        return {
          ok: false,
          kind: "cooldown",
          reason: `This ${label} already claimed recently. Try again later.`,
          retryAfterSeconds: Math.max(1, remaining),
        };
      }
    }

    // 2. daily cap — count sent (24h) + in-flight pending, so concurrent
    //    reservations can't collectively blow past the ceiling.
    const dispensed = db
      .prepare(
        `SELECT COALESCE(SUM(amount_zat), 0) AS total FROM claims
         WHERE (status = 'sent'    AND created_at >= ?)
            OR (status = 'pending' AND created_at >= ?)`,
      )
      .get(o.now - 86_400, o.now - PENDING_LEASE_SECONDS) as { total: number };
    if (dispensed.total + o.amountZat > o.dailyCapZat) {
      return { ok: false, kind: "cap", reason: "Faucet daily cap reached. Please come back tomorrow." };
    }

    // 3. reserve
    const res = db
      .prepare(
        `INSERT INTO claims (address, ip_hash, amount_zat, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(o.address, o.ipHash ?? "", o.amountZat, o.now);
    return { ok: true, claimId: Number(res.lastInsertRowid) };
  },
);

/** Atomically enforce cooldown + daily cap and reserve a pending claim. */
export function reserveClaim(opts: {
  address: string;
  ipHash: string | null;
  amountZat: bigint;
  now: number;
  cooldownSeconds: number;
  dailyCapZat: bigint;
}): ReserveResult {
  return reserveTxn({
    address: opts.address,
    ipHash: opts.ipHash,
    amountZat: Number(opts.amountZat),
    now: opts.now,
    cooldownSeconds: opts.cooldownSeconds,
    dailyCapZat: Number(opts.dailyCapZat),
  });
}

/** Finalise a reserved claim once the send resolves. */
export function finalizeClaim(claimId: number, status: "sent" | "failed", txid: string | null) {
  db.prepare(`UPDATE claims SET status = ?, txid = ? WHERE id = ?`).run(status, txid, claimId);
}
