/**
 * Ledger public API. Backend (local SQLite vs Cloudflare D1) is chosen by
 * config; callers just await reserveClaim / finalizeClaim.
 *
 * The ledger never stores plaintext addresses or IPs — only salted fingerprints
 * (see lib/privacy.ts) — and it purges rows past the retention window, so it
 * holds the minimum needed to enforce cooldowns and nothing more.
 */
import { config } from "../config.ts";
import { fingerprintAddress } from "../privacy.ts";
import type { FaucetNetwork } from "../network.ts";
import { SqliteDriver, D1Driver, type DbDriver } from "./driver.ts";
import {
  FARMING_SIGNALS_SQL,
  farmingSignalsParams,
  RESERVE_SQL,
  SUBNET_COUNT_SQL,
  reserveParams,
  LIVE_BLOCK_SQL,
  FINALIZE_SQL,
  PURGE_SQL,
  DRIP_BUMP_SQL,
  DRIP_TOTALS_SQL,
  DRIP_ANY_SQL,
  DRIP_SEED_SQL,
  PENDING_LEASE_SECONDS,
  SPEND_CHALLENGE_SQL,
  PURGE_CHALLENGES_SQL,
} from "./sql.ts";
import { probeLedger, verdictFor, PROBE_EVERY_MS, type LedgerCacheEntry, type LedgerHealth } from "./probe.ts";

const g = globalThis as unknown as {
  __faucetDriver?: DbDriver;
  // On globalThis for the same reason the driver is: Next gives instrumentation and
  // the route handlers different instances of a module, so a plain module variable
  // is refreshed in one and read as empty in the other (#234).
  __ledgerHealth?: LedgerCacheEntry | null;
  __ledgerProbeInFlight?: boolean;
};
function driver(): DbDriver {
  return (g.__faucetDriver ??=
    config.dbBackend === "d1" ? new D1Driver(config.d1ProxyUrl, config.d1ProxySecret) : new SqliteDriver());
}

export type ReserveResult =
  | { ok: true; claimId: number }
  | { ok: false; kind: "cooldown" | "cap" | "subnet"; reason: string; retryAfterSeconds?: number };

/** Diagnose why an atomic reserve inserted 0 rows (for a useful error message). */
async function whyBlocked(
  addressHash: string,
  ipHash: string | null,
  subnetHash: string | null,
  subnetDailyMax: number,
  now: number,
  cooldownSeconds: number,
  network: DripNetwork,
): Promise<ReserveResult & { ok: false }> {
  const keys: [("address_hash" | "ip_hash"), string, string][] = [["address_hash", addressHash, "address"]];
  if (ipHash) keys.push(["ip_hash", ipHash, "client"]);

  for (const [col, val, label] of keys) {
    // Params follow the statement, and the statement only carries a network clause on
    // the address branch. Built here rather than always passing one, so a mismatch is
    // a compile-visible shape difference instead of a silently ignored extra param.
    const row = await driver().get<{ created_at: number; status: string }>(LIVE_BLOCK_SQL(col), [
      val,
      ...(col === "address_hash" ? [network] : []),
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
  // Distinguish the SUBNET rule from the global cap before falling through. Both
  // block, and telling someone the faucet is empty for the day when it is actually
  // their network that is over quota sends them away for the wrong reason, and hides
  // the signal from us too.
  if (subnetHash) {
    const row = await driver().get<{ n: number }>(SUBNET_COUNT_SQL, [
      subnetHash,
      now - 86_400,
      now - PENDING_LEASE_SECONDS,
    ]);
    if ((row?.n ?? 0) >= subnetDailyMax) {
      return {
        ok: false,
        kind: "subnet",
        // Deliberately does not say "your network", which would confirm to a farmer
        // exactly which limit they hit and how it is keyed. It says enough to be
        // actionable for a real person and no more.
        reason: "Too many claims from your network today. Try again tomorrow, or from a different connection.",
        retryAfterSeconds: 3600,
      };
    }
  }
  // No live cooldown row and no subnet overage → it was the global daily cap.
  return { ok: false, kind: "cap", reason: "Faucet daily cap reached. Please come back tomorrow." };
}

/** Rows older than this can't affect a cooldown or the 24h cap — safe to delete. */
function retentionCutoff(now: number, cooldownSeconds: number): number {
  return now - Math.max(cooldownSeconds, 86_400) - 3_600; // +1h grace
}

/** Atomically enforce cooldown + daily cap and reserve a pending claim. */
export async function reserveClaim(opts: {
  address: string;
  ipHash: string | null;
  /**
   * Already fingerprinted by the caller, because deriving it needs the RAW IP and
   * this layer deliberately never sees one. Null when it could not be derived, which
   * skips the subnet rule rather than inventing a shared bucket.
   */
  subnetHash: string | null;
  amountZat: bigint;
  now: number;
  cooldownSeconds: number;
  /** THIS NETWORK'S cap. The caller picks it; the ledger does not know the config. */
  dailyCapZat: bigint;
  subnetDailyMax: number;
  /**
   * Which chain the claim is for. Defaulted so every existing caller and test keeps
   * meaning what it meant, rather than being silently re-pointed by a new parameter.
   */
  network?: DripNetwork;
}): Promise<ReserveResult> {
  const network = opts.network ?? "taz";
  const addressHash = fingerprintAddress(opts.address);
  const ipHash = opts.ipHash ?? "";
  const subnetHash = opts.subnetHash ?? "";

  // Data minimization: drop expired rows opportunistically (best-effort).
  driver()
    .run(PURGE_SQL, [retentionCutoff(opts.now, opts.cooldownSeconds)])
    .catch(() => {});

  const res = await driver().run(
    RESERVE_SQL,
    reserveParams({
      addressHash,
      ipHash,
      subnetHash,
      amountZat: Number(opts.amountZat),
      now: opts.now,
      cooldownSeconds: opts.cooldownSeconds,
      dailyCapZat: Number(opts.dailyCapZat),
      subnetDailyMax: opts.subnetDailyMax,
      network,
    }),
  );

  if (res.changes === 1) return { ok: true, claimId: res.lastInsertRowid };
  return whyBlocked(
    addressHash,
    opts.ipHash,
    opts.subnetHash,
    opts.subnetDailyMax,
    opts.now,
    opts.cooldownSeconds,
    network,
  );
}

/**
 * Finalise a reserved claim once the send resolves.
 *
 * NULL RATHER THAN "". The old body wrote `txid ?? ""`, so a claim that finished with no
 * transaction id was recorded as one carrying an empty string, which is indistinguishable
 * from having stored an empty id on purpose. Same shape as the balance `?? 0` that hid an
 * unreadable wallet behind a number: the absence was converted at the write, so nothing
 * downstream could recover it.
 *
 * A SENT CLAIM MUST CARRY A TXID unless the network has none to give. Crosslink's
 * `requestfaucetdonation` answers with an amount and no transaction id at all, so its
 * claims genuinely have nothing to record. Every other sender does, and the day a Zallet
 * bug drops one that must land as a failure rather than be filed as an expected absence.
 *
 * The exemption is a spelled-out reason rather than a boolean, so it cannot be passed by
 * accident and reads at the call site as the claim it is making.
 */
export type NoTxidReason = "network-has-no-txid";

/**
 * Which faucet a claim belongs to. TAZ is ours; cTAZ arrives with the crosslink
 * sender (#322).
 *
 * An ALIAS, not a second declaration. `FaucetNetwork` is the one definition, over in
 * lib/network.ts where the labels live, and two independent unions of the same two
 * strings would typecheck against each other forever while being free to diverge the
 * day a third network lands. The name stays because the ledger's callers read in terms
 * of drips and this is exported API.
 */
export type DripNetwork = FaucetNetwork;

export async function finalizeClaim(
  claimId: number,
  status: "sent" | "failed",
  txid: string | null,
  noTxid?: NoTxidReason,
  nowMs: number = Date.now(),
  network: DripNetwork = "taz",
) {
  if (status === "sent" && !txid && !noTxid) {
    throw new Error(
      `finalizeClaim: a sent claim must carry a txid (claim ${claimId}). ` +
        "If this network's send path genuinely returns none, say so explicitly with " +
        "the \"network-has-no-txid\" reason.",
    );
  }
  // `||` rather than `??`, and the difference is deliberate: it folds an EMPTY STRING to
  // NULL as well as undefined. An empty txid is never a valid transaction id, so if a
  // sender ever hands one over it should be recorded as the absence it is rather than
  // preserved as a value someone later has to decide about. The `sent` guard above
  // already refuses "" outright, so this only governs the paths that legitimately have
  // no id: a failed send, and a network that returns none.
  await driver().run(FINALIZE_SQL, [status, txid || null, claimId]);

  // Count the drip, not the drip's details. Best-effort like the purges: a lost
  // increment must never fail a claim that was actually paid, but unlike the purges
  // it is logged, because a counter that drifts silently is a statistic nobody
  // should quote.
  if (status === "sent") {
    driver()
      .run(DRIP_BUMP_SQL, [network, utcDay(nowMs)])
      .catch((e) => console.error(`[drips] count bump failed: ${e instanceof Error ? e.message : e}`));
  }
}

/** UTC calendar day, the only resolution the drip counter keeps. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface DripCounts {
  allTime: number;
  last7d: number;
  last30d: number;
}

/** Single-flight guard for the one-time seed, per process. Cross-process replays are
 * harmless because the seed writes absolute counts with MAX, never increments. */
let seedOnce: Promise<void> | null = null;

/**
 * How many drips this faucet has served: ever, in the last 7 UTC days, and in the
 * last 30, "last 7" meaning today and the six before it.
 *
 * "Ever" begins when this counter shipped, plus the ~25 hours of sent rows retention
 * had not yet deleted, which the seed folds in on first read. Earlier history was
 * deleted by design and is not reconstructable; the counter does not pretend
 * otherwise. Returns null when the ledger will not answer: an unknown count is not
 * zero, same rule as the balance.
 */
export async function countDrips(nowMs: number, network: DripNetwork = "taz"): Promise<DripCounts | null> {
  try {
    // A rejected seed must not be cached: awaiting a poisoned promise forever
    // returns null past the transient failure, and worse, the one-time fold of
    // retention's survivors never happens and retention then deletes them. One
    // transient error at the wrong moment would permanently lose exactly the
    // history this counter exists to preserve. App found it and the fix is theirs.
    seedOnce ??= seedDripDays(nowMs).catch((e) => {
      seedOnce = null;
      throw e;
    });
    await seedOnce;
    const cutoff = (days: number) => utcDay(nowMs - (days - 1) * 86_400_000);
    const row = await driver().get<{ allTime: number; last30d: number; last7d: number }>(
      DRIP_TOTALS_SQL,
      [cutoff(30), cutoff(7), network],
    );
    if (!row) return null;
    return { allTime: Number(row.allTime), last7d: Number(row.last7d), last30d: Number(row.last30d) };
  } catch (e) {
    console.error(`[drips] count read failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Fold surviving sent rows into their day buckets, once, on the first read.
 *
 * Retention keeps ~25 hours, so the survivors span at most three UTC days. One
 * COUNT per candidate day beats streaming rows through a single-row `get`, and
 * the day boundaries are computed here in epoch seconds (`created_at`'s unit:
 * the retention math subtracts 86_400 from it directly) so no SQL date function
 * is involved.
 */
async function seedDripDays(nowMs: number): Promise<void> {
  const any = await driver().get<{ n: number }>(DRIP_ANY_SQL, []);
  if (any && Number(any.n) > 0) return;
  for (let back = 2; back >= 0; back -= 1) {
    const day = utcDay(nowMs - back * 86_400_000);
    const startSec = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
    const r = await driver().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM claims WHERE status = 'sent' AND created_at >= ? AND created_at < ?`,
      [startSec, startSec + 86_400],
    );
    const sent = r ? Number(r.n) : 0;
    // Everything retention has kept was served by the TAZ sender: the crosslink
    // sender does not exist yet, and by the time it does, this seed has run.
    if (sent > 0) await driver().run(DRIP_SEED_SQL, ["taz", day, sent]);
  }
}

/**
 * Spend a proof-of-work challenge. Returns true if this caller got it, false if
 * it was already spent. In the ledger rather than in memory because the web
 * process restarts (watchdog, every deploy) and an in-memory set would silently
 * un-spend every live challenge inside its TTL.
 *
 * Prunes expired rows opportunistically, same best-effort pattern as the claim
 * purge, so the table cannot grow without bound.
 */
export async function spendChallenge(sig: string, exp: number, now: number): Promise<boolean> {
  driver().run(PURGE_CHALLENGES_SQL, [now]).catch(() => {});
  const res = await driver().run(SPEND_CHALLENGE_SQL, [sig, exp]);
  return res.changes === 1;
}

/**
 * Can the ledger answer a read (#217)? Uses the same driver every claim uses, so a
 * pass means the real path is readable rather than that a probe-shaped copy of it
 * is. Never throws: the caller is a health endpoint.
 */
export async function ledgerHealth(): Promise<LedgerHealth> {
  return probeLedger((sql, params) => driver().get(sql, params));
}

/**
 * Re-probe and store. Never throws: probeLedger turns every failure into a state,
 * and a timer callback that throws can take the timer with it.
 */
export async function refreshLedgerHealthNow(): Promise<void> {
  // Coalesce, as the tip oracle does. Without it a slow read plus a fast timer
  // queues reads behind each other and the backlog outlives the problem.
  if (g.__ledgerProbeInFlight) return;
  g.__ledgerProbeInFlight = true;
  try {
    const health = await probeLedger((sql, params) => driver().get(sql, params));
    g.__ledgerHealth = { health, at: Date.now() };
  } finally {
    g.__ledgerProbeInFlight = false;
  }
}

/**
 * The verdict for a caller that must not block (#234): SYNCHRONOUS, last-known.
 *
 * Kicks a background refresh whenever it has nothing fresh to say, which is what
 * makes this self-healing rather than dependent on a timer having armed. That is
 * copied from getExternalTip deliberately, and it is the reason the oracle survived
 * the same module-instance problem that broke my first attempt here: a reader that
 * refreshes converges on its own, a purely passive reader stays empty forever.
 *
 * Fire-and-forget, never awaited, so a slow or wedged ledger cannot make readiness
 * slow. Cold start reads "unknown", which does not block serving: a ledger nobody
 * has asked about yet has not failed.
 */
export function cachedLedgerHealth(now: number = Date.now()): LedgerHealth {
  const verdict = verdictFor(g.__ledgerHealth ?? null, now);
  if (verdict.state === "unknown") void refreshLedgerHealthNow();
  return verdict;
}

/** Test seam: globalThis state would otherwise leak between cases. */
export function resetLedgerHealthCache(): void {
  g.__ledgerHealth = null;
  g.__ledgerProbeInFlight = false;
}

export { PROBE_EVERY_MS };

export interface FarmingSignals {
  claims1h: number;
  distinctIps1h: number;
  distinctAddrs1h: number;
  taz1h: number;
  claims24h: number;
  distinctIps24h: number;
  distinctAddrs24h: number;
  taz24h: number;
  /** claims per distinct IP over 24h, or null when there is nothing to divide. */
  claimsPerIp24h: number | null;
}

/**
 * Counts that make farming visible, over data the ledger already holds (#196).
 *
 * Returns null on any failure rather than throwing. This is a diagnostic read on a
 * timer, and it must never be the reason a faucet stops serving: safeBalance() takes
 * the same position for the same reason. A null here means "we could not look",
 * which the caller says out loud rather than reporting zeros, because zeros would
 * read as a quiet faucet and that is the #172 mistake in a new place.
 */
export async function farmingSignals(now: number): Promise<FarmingSignals | null> {
  try {
    const row = await driver().get<{
      claims_1h: number; ips_1h: number; addrs_1h: number; zat_1h: number;
      claims_24h: number; ips_24h: number; addrs_24h: number; zat_24h: number;
    }>(FARMING_SIGNALS_SQL, farmingSignalsParams(now));
    if (!row) return null;
    const zatToTaz = (z: number) => z / 100_000_000;
    return {
      claims1h: row.claims_1h,
      distinctIps1h: row.ips_1h,
      distinctAddrs1h: row.addrs_1h,
      taz1h: zatToTaz(row.zat_1h),
      claims24h: row.claims_24h,
      distinctIps24h: row.ips_24h,
      distinctAddrs24h: row.addrs_24h,
      taz24h: zatToTaz(row.zat_24h),
      // Guarded rather than allowed to produce Infinity or NaN: a ratio with no
      // denominator is not a big number, it is an absent one.
      claimsPerIp24h: row.ips_24h > 0 ? row.claims_24h / row.ips_24h : null,
    };
  } catch (err) {
    // SAY WHY. The first version swallowed this and returned a bare null, and when it
    // fired for real against a ledger on a full disk I had to patch the code to learn
    // that "disk I/O error" was the cause. An operator hitting the same line would
    // have had no way to tell a broken ledger from an empty one. A ten-minute timer
    // can afford a reason.
    console.error(`[farming] ledger read failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
