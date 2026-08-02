-- Faucet ledger schema for D1. Apply with:
--   wrangler d1 execute zcash-faucet-db --local  --file schema.sql   (local dev)
--   wrangler d1 execute zcash-faucet-db --remote --file schema.sql   (production)
--
-- MIRRORS src/lib/db/sql.ts, and that is now ENFORCED rather than asserted: see the
-- mirror test in src/lib/db/migrations.test.ts. It has to be, because this file had
-- silently fallen three changes behind before anyone looked. It was missing
-- subnet_hash, used_challenges and drip_days, so a D1 deployment applying it got a
-- claims table that RESERVE_SQL could not insert into at all: every claim would have
-- failed on "no such column: subnet_hash", and there was nothing in the repo that
-- would have said so first.
--
-- The sqlite driver runs sql.ts's SCHEMA on every boot and migrates in code. D1 has
-- no equivalent, so THIS FILE IS THE WHOLE STORY for D1 and it carries the columns the
-- migrations add, not just the original ones.
--
-- Privacy-first: only salted hashes of the recipient address + client IP are stored,
-- never plaintext.
CREATE TABLE IF NOT EXISTS claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  address_hash  TEXT    NOT NULL,
  ip_hash       TEXT    NOT NULL,
  amount_zat    INTEGER NOT NULL,
  txid          TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  subnet_hash   TEXT,
  network       TEXT    NOT NULL DEFAULT 'taz'
);

CREATE TABLE IF NOT EXISTS used_challenges (
  sig  TEXT    PRIMARY KEY,
  exp  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drip_days (
  network TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  sent    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (network, day)
);

DROP INDEX IF EXISTS idx_claims_addrhash;
CREATE INDEX IF NOT EXISTS idx_claims_addr_net ON claims(address_hash, network, created_at);
CREATE INDEX IF NOT EXISTS idx_claims_iphash   ON claims(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_claims_created  ON claims(created_at);
CREATE INDEX IF NOT EXISTS idx_used_exp        ON used_challenges(exp);

-- An EXISTING D1 database gets the columns the sqlite side migrates. Not idempotent:
-- ALTER TABLE ADD COLUMN errors if the column is there, and wrangler will say so.
-- Left commented rather than made clever, because "run this once and read the error
-- if it was already run" is honest, and a self-healing script here would need the
-- same already-applied check the code path has, in a file nothing tests.
--   ALTER TABLE claims ADD COLUMN subnet_hash TEXT;
--   ALTER TABLE claims ADD COLUMN network TEXT NOT NULL DEFAULT 'taz';
