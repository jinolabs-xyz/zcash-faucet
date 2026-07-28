/**
 * SQL shared by both ledger backends (local SQLite + Cloudflare D1). Both are
 * SQLite dialects, so the exact same statements run on either — which keeps the
 * concurrency guarantees identical no matter where the ledger lives.
 *
 * Privacy note: we store only SALTED HASHES of the recipient address and client
 * IP (see lib/privacy.ts), never the plaintext. The ledger can enforce cooldowns
 * without ever being a record of who got funded — which matters most for
 * shielded recipients, whom the chain itself does not reveal.
 */

// status: 'pending' (reserved, send in flight) | 'sent' | 'failed'
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  address_hash  TEXT    NOT NULL,
  ip_hash       TEXT    NOT NULL,
  amount_zat    INTEGER NOT NULL,
  txid          TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_addrhash ON claims(address_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_claims_iphash   ON claims(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_claims_created  ON claims(created_at);

CREATE TABLE IF NOT EXISTS used_challenges (
  sig  TEXT    PRIMARY KEY,
  exp  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_used_exp ON used_challenges(exp);
`;

/**
 * Spend a proof-of-work challenge, atomically. The PRIMARY KEY on sig makes the
 * insert itself the mutex: exactly one caller gets changes=1, everyone else
 * gets 0 and is a replay. Same single-statement guarantee the claim reserve
 * relies on, so it holds on D1-over-HTTP too where we cannot lean on Node being
 * single-threaded.
 *
 * The signature already covers seed, difficulty, exp and the client fingerprint,
 * so sig alone identifies the challenge. No need to store anything else, and
 * nothing here is linkable to a person.
 */
export const SPEND_CHALLENGE_SQL = `
INSERT OR IGNORE INTO used_challenges (sig, exp) VALUES (?, ?)
`;

/** Expired challenges can never be replayed, so their rows are dead weight. */
export const PURGE_CHALLENGES_SQL = `
DELETE FROM used_challenges WHERE exp < ?
`;

// A 'pending' row that never finalises (e.g. process died mid-send) shouldn't
// lock a user out for the whole cooldown — it only blocks for this lease.
export const PENDING_LEASE_SECONDS = 120;

/**
 * Atomic reserve: insert a 'pending' claim ONLY IF no live claim exists for this
 * address/client AND the daily cap wouldn't be exceeded. Because SQLite executes
 * a single statement atomically and serialises writers, N concurrent copies of
 * this can't all succeed — exactly one wins the race. No app-side lock needed,
 * so it's correct on D1-over-HTTP too (where we can't rely on Node being
 * single-threaded). Anonymous `?` params for portability across drivers.
 */
export const RESERVE_SQL = `
INSERT INTO claims (address_hash, ip_hash, amount_zat, status, created_at)
SELECT ?, ?, ?, 'pending', ?
WHERE NOT EXISTS (
  SELECT 1 FROM claims WHERE address_hash = ?
    AND ((status='sent' AND created_at > ?) OR (status='pending' AND created_at > ?))
)
AND (
  ? = '' OR NOT EXISTS (
    SELECT 1 FROM claims WHERE ip_hash = ?
      AND ((status='sent' AND created_at > ?) OR (status='pending' AND created_at > ?))
  )
)
AND (
  (SELECT COALESCE(SUM(amount_zat), 0) FROM claims
     WHERE (status='sent' AND created_at >= ?) OR (status='pending' AND created_at >= ?))
  + ?
) <= ?
`;

/** Build the positional params for RESERVE_SQL, in statement order. */
export function reserveParams(o: {
  addressHash: string;
  ipHash: string;
  amountZat: number;
  now: number;
  cooldownSeconds: number;
  dailyCapZat: number;
}): (string | number)[] {
  const cooldownCut = o.now - o.cooldownSeconds;
  const leaseCut = o.now - PENDING_LEASE_SECONDS;
  const since = o.now - 86_400;
  return [
    o.addressHash, o.ipHash, o.amountZat, o.now, // INSERT ... SELECT
    o.addressHash, cooldownCut, leaseCut, //         address NOT EXISTS
    o.ipHash, o.ipHash, cooldownCut, leaseCut, //    ip branch (guard + NOT EXISTS)
    since, leaseCut, o.amountZat, o.dailyCapZat, //  daily cap
  ];
}

/** Most-recent live (blocking) claim for a column, for the "why blocked" message. */
export const LIVE_BLOCK_SQL = (column: "address_hash" | "ip_hash") => `
SELECT created_at, status FROM claims
WHERE ${column} = ?
  AND ((status='sent' AND created_at > ?) OR (status='pending' AND created_at > ?))
ORDER BY created_at DESC LIMIT 1
`;

export const FINALIZE_SQL = `UPDATE claims SET status = ?, txid = ? WHERE id = ?`;

/**
 * Data minimization: once a row is older than the retention window it can no
 * longer affect a cooldown or the 24h cap, so it serves no purpose — delete it.
 * We keep nothing longer than we must.
 */
export const PURGE_SQL = `DELETE FROM claims WHERE created_at < ?`;
