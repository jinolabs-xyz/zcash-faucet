-- Faucet ledger schema for D1. Apply with:
--   wrangler d1 execute zcash-faucet-db --local  --file schema.sql   (local dev)
--   wrangler d1 execute zcash-faucet-db --remote --file schema.sql   (production)
-- Mirrors src/lib/db/sql.ts SCHEMA.
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
