/**
 * The ledger probe (#217).
 *
 * The probe takes its read as a parameter, so these run against the real decision
 * logic with no database and no mocked module. That matters more than usual here:
 * the states worth testing are a ledger that throws and a ledger that never
 * answers, and neither is something you can arrange on demand against a healthy
 * file.
 *
 * What the measured end-to-end run showed, and what the assertions below protect:
 * with `data/faucet.db` present but not a database, health, ready and status all
 * answered 200 with ready:true while every claim returned 500. After this change
 * ready answers 503 with reason "ledger unreadable" and a detail naming the cause.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RATE_LIMIT_SALT = "probe-test-salt";
const { probeLedger, ledgerBlocksServing, verdictFor, MAX_AGE_MS, PROBE_EVERY_MS } = await import("./probe.ts");
const { LEDGER_PROBE_SQL } = await import("./sql.ts");

test("a read that answers is ok", async () => {
  const health = await probeLedger(async () => undefined);
  assert.equal(health.state, "ok");
  assert.ok(health.detail, "even the ok state must carry a detail, or a log line is a bare word");
});

test("a read that THROWS is broken, and the reason survives to the operator", async () => {
  // The exact message better-sqlite3 produces for a corrupt file and for the stale
  // WAL sidecar that made every local claim 500 on 2026-07-29. Losing it would
  // leave an operator unable to tell a broken ledger from an empty one, which is
  // the mistake farmingSignals already made once.
  const health = await probeLedger(async () => {
    throw new Error("file is not a database");
  });
  assert.equal(health.state, "broken");
  assert.match(health.detail, /file is not a database/);
  assert.match(health.detail, /claims cannot be recorded/, "the detail does not say what it costs");
});

test("a non-Error throw is still broken, not a crash", async () => {
  // A driver rejecting with a string or an object must not take out the health
  // endpoint that exists to report it.
  const health = await probeLedger(async () => {
    throw "disk I/O error";
  });
  assert.equal(health.state, "broken");
  assert.match(health.detail, /disk I\/O error/);
});

test("a read that never answers is UNKNOWN, which is not broken", async () => {
  // The distinction the whole module exists for. An absent answer must not become
  // a 503, because /api/ready is what the watchdog pages on and what redeploy
  // rolls back on, so a slow D1 hop would otherwise roll back a good deploy.
  const health = await probeLedger(() => new Promise(() => {}), 30);
  assert.equal(health.state, "unknown");
  assert.match(health.detail, /did not answer within 30ms/);
  assert.notEqual(health.state, "broken", "a timeout was reported as a definite failure");
});

test("only a definite failure blocks serving", async () => {
  // Written as a loop over all three states so a fourth state added later cannot
  // quietly default to permissive.
  assert.equal(ledgerBlocksServing({ state: "ok", detail: "" }), false);
  assert.equal(ledgerBlocksServing({ state: "unknown", detail: "" }), false);
  assert.equal(ledgerBlocksServing({ state: "broken", detail: "" }), true);
});

test("a fast answer leaves NO pending timer behind", async () => {
  // The timer has to be cleared, or every probe holds the event loop open for the
  // full budget and a server build delays its own shutdown and responses.
  //
  // My first version of this test asserted that the probe RESOLVED quickly, which
  // it does either way: the pending timer never delayed the promise, only the event
  // loop. So deleting the clearTimeout left every test green and only the suite's
  // wall-clock moved, from 250ms to 5.2s. Asserting the wrong thing about the right
  // bug is the same false pass this whole file is about, so it now counts the
  // handles Node is actually holding.
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await probeLedger(async () => undefined, 5000);
  const timersAfter = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.equal(timersAfter, timersBefore, "the probe left a live 5s timer holding the event loop open");
});

test("the probe reads a real table, not SELECT 1", async () => {
  // Measured, and it is why the SQL is what it is: a fresh schemaless database
  // answers SELECT 1 happily and cannot record a single claim. So the probe has to
  // touch a table the claim path needs, and this asserts nobody simplifies it back.
  assert.match(LEDGER_PROBE_SQL, /from\s+claims/i);
  assert.doesNotMatch(LEDGER_PROBE_SQL, /^\s*SELECT\s+1\s*$/i);
  // Read-only. A write probe on a path polled every 30 seconds would put rows in
  // the ledger forever.
  assert.doesNotMatch(LEDGER_PROBE_SQL, /INSERT|UPDATE|DELETE|CREATE|DROP/i);
});


test("a slow SYNCHRONOUS read cannot time out, which is the production backend", async () => {
  // Pinned because it is surprising and because a mitigation could be built on the
  // opposite assumption. better-sqlite3 blocks the event loop, so the timer cannot
  // fire until the read has already returned: the timeout is inert for sqlite and
  // only functions for D1. Measured 2026-07-30, sync 600ms against a 100ms budget
  // returns ok after 601ms.
  //
  // The half that matters for safety: slowness still never becomes "broken", so a
  // loaded box cannot manufacture a 503.
  const started = Date.now();
  const health = await probeLedger(() => {
    const until = Date.now() + 250;
    while (Date.now() < until) {} // exactly what a slow synchronous read does
    return Promise.resolve(undefined);
  }, 50);
  assert.equal(health.state, "ok", "a slow sync read must not be called broken");
  assert.ok(Date.now() - started >= 250, "the read did not actually block, so this proves nothing");
});

test("a slow ASYNCHRONOUS read does time out, which is the D1 backend", async () => {
  // The control for the test above. Without it, "ok after 601ms" could just mean
  // the timeout never works at all, and the two tests together are what separate
  // "inert for sync" from "broken everywhere".
  const health = await probeLedger(() => new Promise((r) => setTimeout(r, 250)), 50);
  assert.equal(health.state, "unknown");
});

/* ------------------------------------------- off the readiness path (#234) */

const ok = { state: "ok", detail: "answered" } as const;
const broken = { state: "broken", detail: "file is not a database" } as const;

test("cold start is UNKNOWN, not broken, so a fresh boot still serves", () => {
  // The first trap I named when filing #234. A ledger nobody has asked about yet
  // has not failed, and the oracle's cold cache refusing a legitimate claim is the
  // bug readChainFreshnessAsking exists to work around. unknown must not 503.
  const v = verdictFor(null, 1_000_000);
  assert.equal(v.state, "unknown");
  assert.equal(ledgerBlocksServing(v), false, "a cold cache would refuse claims on a healthy box");
  assert.match(v.detail, /not been probed yet/);
});

test("a fresh verdict is returned as-is", () => {
  assert.equal(verdictFor({ health: ok, at: 1_000_000 }, 1_000_000).state, "ok");
  assert.equal(verdictFor({ health: broken, at: 1_000_000 }, 1_000_000).state, "broken");
});

test("a STALE ok degrades to unknown, because a dead timer must not read as healthy", () => {
  // The second trap, and the reason this is not merely a cache. A timer that stops
  // leaves the last ok in place forever, which is a check reporting health it never
  // re-established: #175's 812 false recoveries in one variable.
  const stale = verdictFor({ health: ok, at: 1_000_000 }, 1_000_000 + MAX_AGE_MS + 1);
  assert.equal(stale.state, "unknown", "a stale ok was still being reported as ok");
  assert.match(stale.detail, /too old to rely on/);
  assert.match(stale.detail, /timer may be dead/, "the detail should name the likely cause");
  assert.equal(ledgerBlocksServing(stale), false, "staleness must not 503 either");
});

test("staleness discards a BROKEN verdict too, not just a good one", () => {
  // Symmetry matters: an old "broken" is equally unestablished, and keeping it would
  // 503 the faucet on evidence nobody has rechecked.
  const stale = verdictFor({ health: broken, at: 5_000_000 }, 5_000_000 + MAX_AGE_MS + 1);
  assert.equal(stale.state, "unknown", "a stale broken kept 503ing without rechecking");
});

test("just inside the age limit is still trusted, so the boundary is not off by one", () => {
  const at = 9_000_000;
  assert.equal(verdictFor({ health: ok, at }, at + MAX_AGE_MS).state, "ok", "exactly at the limit should count");
  assert.equal(verdictFor({ health: ok, at }, at + MAX_AGE_MS + 1).state, "unknown");
});

test("the age limit tolerates two missed refreshes, not zero", () => {
  // Otherwise one slow tick flips readiness to unknown and the state becomes noise.
  assert.ok(MAX_AGE_MS >= 3 * PROBE_EVERY_MS, `${MAX_AGE_MS}ms leaves no room for a missed tick`);
});

test("a broken ledger still reaches a caller through the age rule", () => {
  // The #217 zombie must still be caught. Moving the read off the request path is
  // only correct if the verdict still arrives.
  const v = verdictFor({ health: broken, at: 2_000_000 }, 2_000_000 + 1_000);
  assert.equal(v.state, "broken");
  assert.equal(ledgerBlocksServing(v), true, "the zombie stopped being caught");
  assert.match(v.detail, /file is not a database/);
});
