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

/**
 * Farming signals, one row, over the columns the ledger already holds.
 *
 * WHY IT EXISTS (#196). Every Sybil lever we discussed is untunable without this,
 * and because the daily cap is GLOBAL the first symptom of farming is an empty
 * faucet for everyone. "Ship a mitigation" and "know whether it worked" are
 * different tasks and only one of them was on the plan.
 *
 * The number that matters is claims per DISTINCT ip_hash. One claim per IP is what
 * honest use looks like. Many claims per IP is a shared NAT or a farm, and many IPs
 * each claiming once is either healthy growth or a distributed farm, which is
 * exactly the ambiguity the subnet column exists to resolve.
 *
 * PRIVACY. Every figure is a COUNT or a SUM over data already stored. No hash is
 * returned, nothing new is retained, and nothing is more identifying than what the
 * ledger holds to enforce a cooldown. Subnet spread is deliberately ABSENT rather
 * than approximated, because the column does not exist yet (#213 blocks it) and a
 * guessed figure would be worse than a missing one.
 *
 * Counts sent AND pending, excluding failed, which matches what the daily cap
 * counts: a claim in flight is a claim.
 *
 * The windows are cut-and-newer with no upper bound, which is right for the only
 * caller (a timer passing the current time) and is worth stating because it is not
 * what it looks like: passing an EARLIER `now` widens the window rather than moving
 * it back through history. There is no historical-window query here and this SQL
 * should not be reused as one.
 */
export const FARMING_SIGNALS_SQL = `
SELECT
  (SELECT COUNT(*)                   FROM claims WHERE status <> 'failed' AND created_at >= ?) AS claims_1h,
  (SELECT COUNT(DISTINCT ip_hash)    FROM claims WHERE status <> 'failed' AND created_at >= ?) AS ips_1h,
  (SELECT COUNT(DISTINCT address_hash) FROM claims WHERE status <> 'failed' AND created_at >= ?) AS addrs_1h,
  (SELECT COALESCE(SUM(amount_zat),0) FROM claims WHERE status <> 'failed' AND created_at >= ?) AS zat_1h,
  (SELECT COUNT(*)                   FROM claims WHERE status <> 'failed' AND created_at >= ?) AS claims_24h,
  (SELECT COUNT(DISTINCT ip_hash)    FROM claims WHERE status <> 'failed' AND created_at >= ?) AS ips_24h,
  (SELECT COUNT(DISTINCT address_hash) FROM claims WHERE status <> 'failed' AND created_at >= ?) AS addrs_24h,
  (SELECT COALESCE(SUM(amount_zat),0) FROM claims WHERE status <> 'failed' AND created_at >= ?) AS zat_24h
`;

/** Params for FARMING_SIGNALS_SQL, in statement order: four 1h cuts then four 24h. */
export function farmingSignalsParams(now: number): number[] {
  const hourCut = now - 3600;
  const dayCut = now - 86_400;
  return [hourCut, hourCut, hourCut, hourCut, dayCut, dayCut, dayCut, dayCut];
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
