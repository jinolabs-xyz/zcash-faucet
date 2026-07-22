/**
 * SQLite persistence for claims + rate-limit bookkeeping.
 * One row per successful (or attempted) claim. Kept intentionally simple;
 * swap for Postgres by replacing this module's query layer if you scale out.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

// Reuse a single connection across hot reloads in dev.
const g = globalThis as unknown as { __faucetDb?: Database.Database };
export const db =
  g.__faucetDb ??
  (g.__faucetDb = new Database(join(DATA_DIR, "faucet.db")));

db.pragma("journal_mode = WAL");

// ip_hash is a salted fingerprint, never the raw IP — see lib/privacy.ts.
db.exec(`
  CREATE TABLE IF NOT EXISTS claims (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    address      TEXT    NOT NULL,
    ip_hash      TEXT    NOT NULL,
    amount_zat   INTEGER NOT NULL,
    txid         TEXT,
    status       TEXT    NOT NULL DEFAULT 'sent',  -- 'sent' | 'failed'
    created_at   INTEGER NOT NULL                  -- unix seconds
  );
  CREATE INDEX IF NOT EXISTS idx_claims_address ON claims(address, created_at);
  CREATE INDEX IF NOT EXISTS idx_claims_iphash  ON claims(ip_hash, created_at);
  CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(created_at);
`);

export interface ClaimRow {
  id: number;
  address: string;
  ip_hash: string;
  amount_zat: number;
  txid: string | null;
  status: string;
  created_at: number;
}

export function recordClaim(row: {
  address: string;
  ipHash: string | null;
  amountZat: bigint;
  txid: string | null;
  status: "sent" | "failed";
  createdAt: number;
}) {
  db.prepare(
    `INSERT INTO claims (address, ip_hash, amount_zat, txid, status, created_at)
     VALUES (@address, @ip_hash, @amount_zat, @txid, @status, @created_at)`,
  ).run({
    address: row.address,
    ip_hash: row.ipHash ?? "", // "" = no trusted IP for this claim

    amount_zat: Number(row.amountZat),
    txid: row.txid,
    status: row.status,
    created_at: row.createdAt,
  });
}
