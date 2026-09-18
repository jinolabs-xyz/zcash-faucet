/**
 * Feedback: the only unauthenticated public WRITE path on the site that is not a claim.
 *
 * These read the table directly rather than through an accessor, for the same reason
 * drips.test.ts does: the question is what is STORED, and an accessor is what would flatten
 * the distinctions away. Time is injected everywhere so nothing depends on the wall clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-feedback-")));
process.env.DB_BACKEND = "sqlite";

const { recordFeedback, purgeFeedback, MAX_FEEDBACK_BODY, FEEDBACK_PER_DAY, FEEDBACK_RETENTION_SECONDS } =
  await import("./index.ts");
const { SqliteDriver } = await import("./driver.ts");

const NOW_MS = Date.parse("2026-09-19T12:00:00Z");
const raw = new SqliteDriver();
const rows = async () => (await raw.all<{ body: string; reply_to: string | null; ip_hash: string | null; sent_at: number | null }>(
  `SELECT body, reply_to, ip_hash, sent_at FROM feedback ORDER BY id`, []));
const count = async () => Number((await raw.get<{ n: number }>(`SELECT COUNT(*) AS n FROM feedback`, []))?.n ?? -1);

test("a message is stored undelivered, and the app does not pretend otherwise", async () => {
  const r = await recordFeedback({ body: "the fox is lovely", replyTo: null, ipHash: "ip-a", now: NOW_MS });
  assert.equal(r.ok, true);
  const [row] = await rows();
  assert.equal(row.body, "the fox is lovely");
  // SENT_AT IS THE QUEUE AND IT MUST START NULL. A row written as already-sent would be
  // skipped by the drainer forever and nobody would ever see the message - the failure
  // would be silent on both sides, which is the worst shape available here.
  assert.equal(row.sent_at, null);
});

test("an over-long body is REFUSED, not truncated", async () => {
  const before = await count();
  const r = await recordFeedback({ body: "x".repeat(MAX_FEEDBACK_BODY + 1), replyTo: null, ipHash: "ip-b", now: NOW_MS });
  assert.deepEqual(r, { ok: false, reason: "too-long" });
  // The row is the assertion, not the return value. Truncating someone's words and then
  // reporting success is a lie about what we received, and the sender cannot discover it.
  assert.equal(await count(), before, "nothing was written");
  // The boundary itself is accepted, so the limit is not off by one against the sender.
  const edge = await recordFeedback({ body: "y".repeat(MAX_FEEDBACK_BODY), replyTo: null, ipHash: "ip-b", now: NOW_MS });
  assert.equal(edge.ok, true);
});

test("an empty or whitespace-only body is refused", async () => {
  const before = await count();
  assert.deepEqual(await recordFeedback({ body: "   \n\t ", replyTo: null, ipHash: "ip-c", now: NOW_MS }), { ok: false, reason: "empty" });
  assert.equal(await count(), before);
});

test("the cap holds per fingerprint, and the NEXT day is a fresh allowance", async () => {
  for (let i = 0; i < FEEDBACK_PER_DAY; i++) {
    assert.equal((await recordFeedback({ body: `m${i}`, replyTo: null, ipHash: "ip-cap", now: NOW_MS })).ok, true, `#${i}`);
  }
  assert.deepEqual(
    await recordFeedback({ body: "one too many", replyTo: null, ipHash: "ip-cap", now: NOW_MS }),
    { ok: false, reason: "rate" });
  // A WINDOW, NOT A LIFETIME BAN. Without this row the cap could be implemented as "ever"
  // and the test above would not notice - someone who sent five messages in March would be
  // silenced permanently.
  const nextDay = NOW_MS + 86_400_000 + 1000;
  assert.equal((await recordFeedback({ body: "the day after", replyTo: null, ipHash: "ip-cap", now: nextDay })).ok, true);
});

test("no fingerprint is not a free pass - the unidentified share one bucket", async () => {
  // A caller we cannot identify is exactly the one an abuser would arrange to be, so the cap
  // applies to the null key rather than being skipped when the key is missing. This is the
  // row that would catch `if (!ipHash) return insert()`.
  for (let i = 0; i < FEEDBACK_PER_DAY; i++) {
    assert.equal((await recordFeedback({ body: `anon ${i}`, replyTo: null, ipHash: null, now: NOW_MS })).ok, true);
  }
  assert.deepEqual(
    await recordFeedback({ body: "anon overflow", replyTo: null, ipHash: null, now: NOW_MS }),
    { ok: false, reason: "rate" });
});

test("reply_to is stored exactly as given, and is optional", async () => {
  // NOT PARSED AND NOT VALIDATED INTO A PROMISE. It is a string someone typed; treating it
  // as a verified address would let the page imply a reply is possible when it may not be.
  await recordFeedback({ body: "with contact", replyTo: "  someone@example.org  ", ipHash: "ip-r", now: NOW_MS });
  await recordFeedback({ body: "without contact", replyTo: null, ipHash: "ip-r", now: NOW_MS });
  const all = await rows();
  const withContact = all.find((r) => r.body === "with contact");
  const without = all.find((r) => r.body === "without contact");
  assert.equal(withContact?.reply_to, "someone@example.org", "trimmed, not otherwise touched");
  assert.equal(without?.reply_to, null, "absent stays absent rather than becoming an empty string");
});

test("retention deletes old rows whether or not anyone delivered them", async () => {
  const old = NOW_MS - (FEEDBACK_RETENTION_SECONDS + 86_400) * 1000;
  await recordFeedback({ body: "ancient and undelivered", replyTo: null, ipHash: "ip-old", now: old });
  const before = await count();
  await purgeFeedback(NOW_MS);
  const after = await count();
  assert.ok(after < before, "the aged row is gone");
  const left = await rows();
  assert.equal(left.find((r) => r.body === "ancient and undelivered"), undefined);
  // THE UNDELIVERED HALF IS THE POINT. A purge that only removed delivered rows would turn
  // a broken drainer into an unbounded store of human-written text, which is the opposite of
  // what the rest of this ledger does. That row was never sent and it still went.
  assert.ok(left.length > 0, "and it did not take the recent rows with it");
});
