/**
 * SQL shared by both ledger backends (local SQLite + Cloudflare D1). Both are
 * SQLite dialects, so the exact same statements run on either - which keeps the
 * concurrency guarantees identical no matter where the ledger lives.
 *
 * Privacy note: we store only SALTED HASHES of the recipient address and client
 * IP (see lib/privacy.ts), never the plaintext. The ledger can enforce cooldowns
 * without ever being a record of who got funded - which matters most for
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
  -- rows written before it existed have none and a migration cannot invent one,
  -- so the cap treats a NULL as out of scope rather than as a shared bucket.
  subnet_hash   TEXT,
  -- Which chain this claim was paid on: 'taz' or 'ctaz' (#326). NOT NULL with a
  -- default, so every row that predates the toggle is TAZ, which is what it was.
  --
  -- WHY A COLUMN AND NOT A FOLD INTO THE HASH. The cheap version is to fingerprint
  -- ('ctaz' + address) and get a separate bucket for free, no migration, three
  -- lines. It is wrong, and it is wrong quietly. It hides the dimension inside a
  -- hash where no query can reach it, and it CORRUPTS THE FARMING SIGNALS: one
  -- honest person claiming on both networks becomes two distinct address hashes,
  -- so claims-per-distinct-address drifts toward 1 in exactly the way a farm makes
  -- it drift, and the number we built to catch farming would be reading our own
  -- toggle. Same family as the drip counter one table down: a dimension not stored
  -- at the write cannot be recovered later.
  network       TEXT    NOT NULL DEFAULT 'taz'
);

CREATE TABLE IF NOT EXISTS used_challenges (
  sig  TEXT    PRIMARY KEY,
  exp  INTEGER NOT NULL
);

-- Drips served, by network and UTC day. The claims table cannot answer "how
-- many, ever": data minimization deletes its rows after ~25 hours, and that is
-- a feature we will not weaken for a statistic. So the statistic lives here, as
-- a count per day and NOTHING else: no address hash, no ip hash, no amount, no
-- timestamps finer than the day. Nothing in this table is about anyone.
--
-- The network is part of the key from day one, before anything ships, because
-- mixed rows cannot be separated retroactively: the day the cTAZ sender lands,
-- a single counter would silently change meaning from "TAZ drips" to "TAZ plus
-- cTAZ", and the information needed to split it would already be destroyed at
-- the write. Third instance of that pattern this week (balance ?? 0,
-- txid ?? ""), each cheap to prevent and impossible to undo.
CREATE TABLE IF NOT EXISTS drip_days (
  network TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  sent    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (network, day)
);
`;

/**
 * Indexes, applied AFTER the migrations rather than with the tables.
 *
 * They used to live at the bottom of SCHEMA, and that ordering only worked while no
 * index mentioned a migrated column. `idx_claims_addr_net` covers `network`, and the
 * driver runs SCHEMA before migrate(), so on an existing database the CREATE INDEX
 * would have hit "no such column: network" at boot, before the ALTER that adds it.
 * Fresh boxes would have been fine and every existing one would have died, which is
 * the #213 shape again: the artifact that defines the contract only reaching the
 * thing that does not exist yet.
 *
 * An index cannot be created before its columns exist, so this ordering is not a
 * workaround, it is the only correct one. Separated as data rather than fixed by
 * shuffling statements inside one string, so the constraint is visible.
 */
export const INDEXES = `
-- The cooldown lookup is keyed (address_hash, network) now, so network comes BEFORE
-- created_at: the first two are equalities and the third is a range, which is the
-- only order sqlite can use the whole index for. The old two-column index is dropped
-- rather than left behind, because a stale index is write cost with no read benefit.
DROP INDEX IF EXISTS idx_claims_addrhash;
CREATE INDEX IF NOT EXISTS idx_claims_addr_net ON claims(address_hash, network, created_at);
-- ip and subnet are deliberately NOT keyed by network, and that matches their queries
-- rather than being an omission: those two limits are global. See RESERVE_SQL.
CREATE INDEX IF NOT EXISTS idx_claims_iphash   ON claims(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_claims_created  ON claims(created_at);
CREATE INDEX IF NOT EXISTS idx_used_exp        ON used_challenges(exp);
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
  {
    // NOT NULL needs a default in an ALTER, and 'taz' is not a convenience here: every
    // row that predates the toggle WAS a TAZ claim, so backfilling them as TAZ records
    // what happened rather than guessing at it.
    id: "claims.network",
    presentWhen: { table: "claims", column: "network" },
    sql: "ALTER TABLE claims ADD COLUMN network TEXT NOT NULL DEFAULT 'taz'",
  },
  {
    // #351, and it is #213 for the fourth time: the network column went into SCHEMA
    // with no migration beside it, so it reached fresh databases and no existing one.
    //
    // A REBUILD, not an ALTER, and that is forced rather than cautious: the column
    // belongs to the PRIMARY KEY, and sqlite's ALTER TABLE ADD COLUMN cannot extend
    // one. Adding it as a plain column would leave the table keyed on `day` alone,
    // which is worse than the bug it fixes: the first cTAZ drip on a day TAZ already
    // served would collide on the key instead of opening its own bucket.
    //
    // Backfilling 'taz' is the same reasoning as claims.network above. Every bucket
    // that predates the split was counted before a second asset existed.
    id: "drip_days.network",
    presentWhen: { table: "drip_days", column: "network" },
    sql: `
CREATE TABLE drip_days_rebuild (
  network TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  sent    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (network, day)
);
INSERT INTO drip_days_rebuild (network, day, sent) SELECT 'taz', day, sent FROM drip_days;
DROP TABLE drip_days;
ALTER TABLE drip_days_rebuild RENAME TO drip_days;`,
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
/**
 * The cheapest read that proves the ledger can record a claim (#217).
 *
 * Against `claims` rather than `SELECT 1`, and I had the reason wrong until I ran
 * it. I assumed `SELECT 1` never touches the file. It does throw on a corrupt one.
 * What it does NOT catch is the case that matters just as much, measured on
 * 2026-07-30 with better-sqlite3:
 *
 *   corrupt file   SELECT 1                       THROWS "file is not a database"
 *   corrupt file   SELECT id FROM claims LIMIT 0  THROWS "file is not a database"
 *   fresh empty    SELECT 1                       OK
 *   fresh empty    SELECT id FROM claims LIMIT 0  THROWS "no such table: claims"
 *
 * A schemaless ledger answers `SELECT 1` happily and cannot record a single claim.
 * Reading a table the claim path actually needs catches corruption AND a missing
 * schema, which is the difference between proving we can talk to sqlite and
 * proving we have a ledger. The D1 driver has never run SCHEMA at all, so the
 * second column is not a theoretical worry there.
 *
 * LIMIT 0 so the cost is a table lookup with no rows crossing the wire, which
 * matters on D1 where every query is an HTTPS round-trip.
 */
export const LEDGER_PROBE_SQL = "SELECT id FROM claims LIMIT 0";

export const SPEND_CHALLENGE_SQL = `
INSERT OR IGNORE INTO used_challenges (sig, exp) VALUES (?, ?)
`;

/** Expired challenges can never be replayed, so their rows are dead weight. */
export const PURGE_CHALLENGES_SQL = `
DELETE FROM used_challenges WHERE exp < ?
`;

// A 'pending' row that never finalises (e.g. process died mid-send) shouldn't
// lock a user out for the whole cooldown - it only blocks for this lease.
export const PENDING_LEASE_SECONDS = 120;

/**
 * Atomic reserve: insert a 'pending' claim ONLY IF no live claim exists for this
 * address/client AND the daily cap wouldn't be exceeded. Because SQLite executes
 * a single statement atomically and serialises writers, N concurrent copies of
 * this can't all succeed - exactly one wins the race. No app-side lock needed,
 * so it's correct on D1-over-HTTP too (where we can't rely on Node being
 * single-threaded). Anonymous `?` params for portability across drivers.
 *
 * TWO OF THESE FOUR LIMITS ARE PER NETWORK AND TWO ARE NOT, and the split is the
 * design rather than an oversight (#326).
 *
 *   address cooldown   PER NETWORK. Different chains are different money. Someone
 *                      trying the feature net should not spend their TAZ drip to do it.
 *   daily cap          PER NETWORK. It is a drain guard and they are different wallets:
 *                      a busy cTAZ day must not close the TAZ faucet.
 *   ip cap             GLOBAL.
 *   subnet cap         GLOBAL.
 *
 * The last two are the point. Those are ANTI-ABUSE budgets, not accounting, and
 * splitting them per network would turn the toggle into a doubling device: a farmer
 * alternates networks and takes twice as much from one address range, using a lever
 * we built and handed over. So they stay global, and the consequence is deliberate: a
 * legitimate person claiming on both networks spends two slots of their subnet budget.
 * That is correct. The budget is per person-ish, not per network.
 */
export const RESERVE_SQL = `
INSERT INTO claims (address_hash, ip_hash, subnet_hash, amount_zat, status, created_at, network)
SELECT ?, ?, ?, ?, 'pending', ?, ?
WHERE NOT EXISTS (
  SELECT 1 FROM claims WHERE address_hash = ? AND network = ?
    AND ((status='sent' AND created_at > ?) OR (status='pending' AND created_at > ?))
)
AND (
  -- PER NETWORK, BY THE OWNER'S DECISION 2026-08-04: one drip of each asset per 24h.
  -- This clause used to be global, and the comment above still explains why that was
  -- defensible. It is being overridden deliberately, not by accident.
  --
  -- What it costs: a client can now take one TAZ and one cTAZ in the same day, so the
  -- per-connection budget is two drips rather than one. What it buys is the thing the
  -- owner actually wanted - the two assets are separate faucets, and claiming one must
  -- not silently spend the other's entitlement. The failure it fixes was worse than the
  -- abuse it permits: someone who claimed TAZ was told their address "got its 0.5 cTAZ"
  -- when the ledger held zero cTAZ claims, ever.
  --
  -- The SUBNET cap below stays global on purpose. That one is a volume control against a
  -- range, not a per-person entitlement, and splitting it would hand a farmer exactly the
  -- lever the comment above warns about: alternate networks, take twice as much.
  ? = '' OR NOT EXISTS (
    SELECT 1 FROM claims WHERE ip_hash = ? AND network = ?
      AND ((status='sent' AND created_at > ?) OR (status='pending' AND created_at > ?))
  )
)
AND (
  ? = '' OR (
    SELECT COUNT(*) FROM claims WHERE subnet_hash = ?
      AND ((status='sent' AND created_at >= ?) OR (status='pending' AND created_at >= ?))
  ) < ?
)
AND (
  (SELECT COALESCE(SUM(amount_zat), 0) FROM claims
     WHERE network = ?
       AND ((status='sent' AND created_at >= ?) OR (status='pending' AND created_at >= ?)))
  + ?
) <= ?
`;

/** Build the positional params for RESERVE_SQL, in statement order. */
export function reserveParams(o: {
  addressHash: string;
  ipHash: string;
  /** "" when the client's subnet could not be derived, which SKIPS the subnet rule. */
  subnetHash: string;
  amountZat: number;
  now: number;
  cooldownSeconds: number;
  /** This network's cap, not a global one. cTAZ carries its own (config.crosslink). */
  dailyCapZat: number;
  subnetDailyMax: number;
  network: string;
}): (string | number)[] {
  const cooldownCut = o.now - o.cooldownSeconds;
  const leaseCut = o.now - PENDING_LEASE_SECONDS;
  const since = o.now - 86_400;
  return [
    o.addressHash, o.ipHash, o.subnetHash, o.amountZat, o.now, o.network, // INSERT ... SELECT
    o.addressHash, o.network, cooldownCut, leaseCut, //           address NOT EXISTS, per network
    o.ipHash, o.ipHash, o.network, cooldownCut, leaseCut, //      ip branch, PER NETWORK since 2026-08-04
    o.subnetHash, o.subnetHash, since, leaseCut, o.subnetDailyMax, // subnet branch, GLOBAL
    o.network, since, leaseCut, o.amountZat, o.dailyCapZat, //    daily cap, per network
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
 * than approximated: the column now exists AND is populated, but this query does
 * not aggregate it yet (#213), and a guessed figure would be worse than a missing
 * one. The old reason here was that the column did not exist, which stopped being
 * true when the subnet cap landed.
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

/** How many claims a subnet has made in the window, for the "why blocked" message. */
export const SUBNET_COUNT_SQL = `
SELECT COUNT(*) AS n FROM claims
WHERE subnet_hash = ?
  AND ((status='sent' AND created_at >= ?) OR (status='pending' AND created_at >= ?))
`;

/**
 * Most-recent live (blocking) claim for a column, for the "why blocked" message.
 *
 * Scoped exactly as the matching branch of RESERVE_SQL is, which is why the network
 * clause is conditional rather than always on: address is per network, ip is global.
 * If these two ever disagree the reserve refuses and the explanation cannot find a
 * reason, and the user is told the daily cap was reached when it was not.
 */
export const LIVE_BLOCK_SQL = (column: "address_hash" | "ip_hash") => `
SELECT created_at, status FROM claims
WHERE ${column} = ? AND network = ?
  AND ((status='sent' AND created_at > ?) OR (status='pending' AND created_at > ?))
ORDER BY created_at DESC LIMIT 1
`;

export const FINALIZE_SQL = `UPDATE claims SET status = ?, txid = ? WHERE id = ?`;

/** One more drip served today. The day arrives as a param: SQL date functions differ
 * between backends, an ISO string compares correctly everywhere, and the caller's
 * clock is the one the rest of the ledger already runs on. */
export const DRIP_BUMP_SQL = `
INSERT INTO drip_days (network, day, sent) VALUES (?, ?, 1)
ON CONFLICT(network, day) DO UPDATE SET sent = sent + 1`;

/** All three windows in one read. ISO days compare lexicographically, so >= on
 * strings is a correct date comparison and works on both backends. */
export const DRIP_TOTALS_SQL = `
SELECT COALESCE(SUM(sent), 0)                              AS allTime,
       COALESCE(SUM(CASE WHEN day >= ? THEN sent END), 0)  AS last30d,
       COALESCE(SUM(CASE WHEN day >= ? THEN sent END), 0)  AS last7d
  FROM drip_days
 WHERE network = ?`;

export const DRIP_ANY_SQL = `SELECT COUNT(*) AS n FROM drip_days`;

/** MAX rather than +: the seed writes absolute per-day counts, so replaying it
 * (two processes, a restart mid-seed) cannot double-count. */
export const DRIP_SEED_SQL = `
INSERT INTO drip_days (network, day, sent) VALUES (?, ?, ?)
ON CONFLICT(network, day) DO UPDATE SET sent = MAX(sent, excluded.sent)`;

/**
 * Data minimization: once a row is older than the retention window it can no
 * longer affect a cooldown or the 24h cap, so it serves no purpose - delete it.
 * We keep nothing longer than we must.
 */
export const PURGE_SQL = `DELETE FROM claims WHERE created_at < ?`;
