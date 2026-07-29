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
  created_at    INTEGER NOT NULL,
  -- Coarser than ip_hash: a salted hash of the client's SUBNET, for limiting a
  -- cloud range without limiting a person (#196). NULLABLE on purpose, because
  -- rows written before it existed have none and a migration cannot invent one.
  -- Nothing reads it yet.
  subnet_hash   TEXT
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
 * Schema changes for databases that ALREADY EXIST.
 *
 * SCHEMA above is `CREATE TABLE IF NOT EXISTS`, which is a NO-OP on a database that
 * already has the table. So a column added there reaches a fresh database and never
 * an existing one, and the next INSERT naming it fails every claim. That is #213,
 * and it is the third appearance of one pattern: the artifact defining the contract
 * only applies to something that does not exist yet (#172's env var, #177's
 * write_env seeding the example once, and now the schema).
 *
 * Idempotent BY CONSTRUCTION rather than by swallowing an error. Each migration
 * declares how to tell whether it is already applied, the runner checks that first,
 * and nothing relies on parsing "duplicate column name" out of a driver's message.
 * An error-swallowing runner cannot distinguish "already applied" from "broken", and
 * that distinction is the whole job.
 *
 * Fresh and migrated databases must converge: every column added here is also in
 * SCHEMA, and there is a test asserting the two paths produce identical tables.
 * Otherwise a box's behaviour would depend on when its database was created.
 */
export interface Migration {
  /** Stable name, for the log line when it runs. */
  id: string;
  /** Already applied when this table has this column. */
  presentWhen: { table: string; column: string };
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "claims.subnet_hash",
    presentWhen: { table: "claims", column: "subnet_hash" },
    sql: "ALTER TABLE claims ADD COLUMN subnet_hash TEXT",
  },
];

/** Columns a table currently has. The idempotence check, and the test's read too. */
export const TABLE_COLUMNS_SQL = (table: string) => `PRAGMA table_info(${table})`;

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
