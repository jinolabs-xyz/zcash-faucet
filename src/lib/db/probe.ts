/**
 * Can the ledger answer? The app-side half of #217.
 *
 * WHY THIS EXISTS, measured rather than argued. With `data/faucet.db` present but
 * not a database, on 2026-07-30:
 *
 *   /api/health   200
 *   /api/ready    200   ready: true, reason: null
 *   /api/status   200
 *   POST /api/faucet  500, every time
 *
 * That is the zombie #217 is about, and it is not hypothetical: it is the shape of
 * the stale-WAL-sidecar failure from 2026-07-29, where every local claim returned
 * 500 while the app looked entirely healthy. The watchdog would have reported a
 * healthy faucet and an operator would have gone to look at docker, which shows
 * everything running.
 *
 * The cause is a gap, not a bug: /api/health does no backend work by design, and
 * neither /api/ready nor /api/status touches the ledger. So NOTHING the monitoring
 * path can reach asks the one component every claim depends on.
 *
 * THREE STATES, and the middle one is the whole reason this is not a boolean:
 *
 *   ok       a trivial read came back. Claims can be recorded.
 *   broken   the driver THREW on a trivial read. Claims will 500. Say so.
 *   unknown  we could not get an answer either way, e.g. the D1 proxy hop timed
 *            out. NOT the same as broken, and it must not page as an outage.
 *
 * Readiness FAILS OPEN on unknown, deliberately, and closed on broken. The
 * difference is that broken is positive evidence of a failure we caused, while
 * unknown is an absent answer, and turning an absent answer into a 503 hands a
 * network blip the power to trip the watchdog and roll back a good deploy. That
 * outage-amplifier is a bug we have already paid for once on the tip oracle.
 */
import { config } from "../config.ts";
import { LEDGER_PROBE_SQL } from "./sql.ts";

export type LedgerState = "ok" | "broken" | "unknown";

export interface LedgerHealth {
  state: LedgerState;
  /** Always populated, including when ok, so a log line is never a bare state. */
  detail: string;
}

/**
 * Longest we wait for the ledger before calling it unknown.
 *
 * Local SQLite is synchronous and answers in microseconds, so this bound exists
 * for the D1 backend, where every query is an HTTPS round-trip. Two seconds is
 * well under the watchdog's 8s curl budget, which matters: a probe that outlives
 * the thing polling it converts a slow ledger into a timeout upstream, and then
 * the reason never reaches anybody.
 */
const PROBE_TIMEOUT_MS = 2000;

/*
 * MEASURED LIMIT, and it is the opposite of reassuring, so it is written here
 * rather than left for someone to assume their way past. Asked by SDE-Infra while
 * reviewing this: on a loaded box, does a slow-but-fine ledger read land in
 * "unknown" or get called a definite failure? Neither, on the backend we deploy.
 *
 *   sync read 600ms vs a 100ms timeout   ->  state=ok,      elapsed 601ms
 *   async read 600ms vs a 100ms timeout  ->  state=unknown, elapsed 101ms
 *
 * better-sqlite3 is SYNCHRONOUS. A slow read blocks the event loop, so the timer
 * below cannot fire until the read has already finished. The timeout is therefore
 * INERT for sqlite and only functions for D1, where the query is a real await.
 *
 * The good half: slowness can never be reported as "broken" on either backend, so
 * a loaded box cannot manufacture a 503. The bad half: "unknown" is effectively
 * unreachable in production, so /api/ready simply answers 200 LATE, and whoever is
 * polling hits their own timeout instead. That makes the slow-versus-definite
 * boundary a property of the CALLER's budget, not of this module, and any
 * mitigation that waits for `ledger.state === "unknown"` to appear on the box will
 * wait forever. Fixing it properly means moving the read off the request thread,
 * which is a bigger change than this one and not obviously worth it.
 */

/**
 * Does NOT create or migrate anything. `read` is a plain SELECT against a table
 * the schema guarantees, so a passing probe means the ledger is readable, not that
 * it is writable. That is a real limit and it is the honest one to have: a
 * read-only filesystem would pass here and still fail a claim. Naming it beats
 * pretending, and a write probe on a liveness path would put rows in the ledger
 * every 30 seconds forever.
 */
export async function probeLedger(
  read: (sql: string, params: (string | number)[]) => Promise<unknown>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<LedgerHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("timeout");
  try {
    const raced = await Promise.race([
      read(LEDGER_PROBE_SQL, []).then(() => "answered" as const),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (raced === TIMED_OUT) {
      return {
        state: "unknown",
        detail: `the ledger did not answer within ${timeoutMs}ms, so its state is unverified`,
      };
    }
    return { state: "ok", detail: `${config.dbBackend} ledger answered a read` };
  } catch (err) {
    // A throw is POSITIVE evidence, unlike a timeout. better-sqlite3 reports a
    // stale sidecar, a corrupt file and a full disk all as SqliteError, so the
    // message is what an operator actually needs and it goes in the reason.
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "broken",
      detail: `the ${config.dbBackend} ledger failed a read, so claims cannot be recorded: ${message}`,
    };
  } finally {
    // Otherwise a fast answer leaves the timer pending and holds the event loop
    // open for two seconds, which in a serverless build delays every response.
    if (timer) clearTimeout(timer);
  }
}

/** True only for a definite failure. Never for unknown. See the module comment. */
export function ledgerBlocksServing(health: LedgerHealth): boolean {
  return health.state === "broken";
}

/* ==========================================================================
 * Getting the read OFF the readiness path (#234).
 *
 * #228 put `await ledgerHealth()` inside /api/ready. The CTO called that a
 * regression in the thing #171 exists to prevent, and they are right: a network or
 * IO call on the readiness critical path couples our availability to how fast that
 * call answers, and /api/ready is what the watchdog pages on and what redeploy
 * rolls back on. #171 fixed the identical mistake for the tip oracle by making the
 * value timer-refreshed and having readers read last-known synchronously. Same fix
 * here, same shape, deliberately.
 *
 * WHAT THIS BUYS, precisely, because it is less than it looks:
 *
 *   1. readiness never AWAITS a ledger read, so its latency stops being a function
 *      of one, and at most one read per interval can cost anything at all.
 *   2. `unknown` becomes REACHABLE. Before, on sqlite, it was unreachable: a slow
 *      read blocked the timer that was supposed to fire, so the state machine had a
 *      branch nothing could enter. Now staleness produces it, which is the state
 *      Infra needs for #229 and could not observe.
 *
 * WHAT IT DOES NOT BUY, and this is the honest limit rather than a caveat. Node is
 * single-threaded and better-sqlite3 is SYNCHRONOUS, so a slow read blocks the event
 * loop wherever it is called from. Moving it to a timer means readiness does not
 * wait for it, NOT that a wedged sqlite read stops stalling in-flight responses. On
 * D1 the coupling is genuinely gone, since that query is a real await. Removing it
 * for sqlite means moving the read to a worker thread, which is a larger change than
 * this and is not obviously worth it at the measured margin (Infra: 0.39 to 0.66s of
 * server-side work against an 8s budget, and the probe is not what costs it).
 * ========================================================================== */

/** How often the background timer re-probes. Matches the oracle's cadence. */
export const PROBE_EVERY_MS = 30_000;

/**
 * Beyond this we stop claiming to know, even if the last answer was `ok`.
 *
 * This is the whole reason the cache is not just a cache. A dead timer that leaves
 * the last `ok` in place forever is a check that reports health it never
 * re-established, which is the failure mode of every cache in this repo and the one
 * #175's 812 false recoveries were made of. Three intervals, so two missed refreshes
 * are tolerated and the third stops the claim.
 */
export const MAX_AGE_MS = 3 * PROBE_EVERY_MS;

export interface LedgerCacheEntry {
  health: LedgerHealth;
  at: number;
}

/**
 * The age rule, pure. Given what we last learned and when, what may we claim now?
 *
 * Pure and here rather than beside the cache, for the reason decide.ts and
 * chainFreshness are: the branches worth testing are cold-start and a dead timer,
 * and neither should need a database or a clock to reach.
 *
 * THE STATE ITSELF IS NOT HERE, and that is deliberate and hard-won. It lived in
 * this module first, backed by an ordinary module-level variable, and it did not
 * work: `register()` refreshed one instance of this module while `/api/ready` read
 * another, so the timer ran, the probe found the broken ledger, and readiness still
 * answered 200 with "has not been probed yet". Seventeen unit tests passed while the
 * feature was inert. The repo already had the answer, in `db/index.ts`: state that
 * must survive Next's module boundaries goes on `globalThis`, exactly as the driver
 * does. So the cache lives next to the driver and this stays a rule about ages.
 */
export function verdictFor(entry: LedgerCacheEntry | null, now: number): LedgerHealth {
  if (entry === null) {
    return { state: "unknown", detail: "the ledger has not been probed yet, so its state is unestablished" };
  }
  const age = now - entry.at;
  if (age > MAX_AGE_MS) {
    // Deliberately discards a stale `ok`. An answer this old is not evidence.
    return {
      state: "unknown",
      detail:
        `the last ledger probe was ${Math.round(age / 1000)}s ago (limit ${Math.round(MAX_AGE_MS / 1000)}s), ` +
        `so its verdict of "${entry.health.state}" is too old to rely on and the refresh timer may be dead`,
    };
  }
  return entry.health;
}
