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
const { probeLedger, ledgerBlocksServing } = await import("./probe.ts");
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
