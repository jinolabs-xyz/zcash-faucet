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
