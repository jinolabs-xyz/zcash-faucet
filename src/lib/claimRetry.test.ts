import { test } from "node:test";
import assert from "node:assert/strict";
import {
  silentRetryWaitSeconds,
  retriesExhaustedNote,
  SILENT_RETRY_CAP,
  SILENT_RETRY_MAX_SECONDS,
  RETRY_STEP_LABEL,
} from "./claimRetry.ts";

const held = (retryAfterSeconds: unknown) => ({ status: 503, retryAfterSeconds });

test("our own node being slow is retried, because it clears by itself in seconds", () => {
  assert.equal(silentRetryWaitSeconds(held(5), 0), 5);
  assert.equal(silentRetryWaitSeconds(held(1), 0), 1);
});

test("the threshold matches what the SERVER's own test guarantees, or the feature dies silently", () => {
  // freshness-retry.test.ts asserts only `quick <= 10` for the wobble hint. If this threshold sat
  // at 5, a server returning 8 would keep BOTH suites green and switch the retry off entirely.
  // Two green suites that disagree about a number on the wire is the failure this row exists for.
  assert.ok(SILENT_RETRY_MAX_SECONDS >= 10, `the server permits up to 10s; got ${SILENT_RETRY_MAX_SECONDS}`);
  for (const quick of [1, 5, 8, 10]) assert.equal(silentRetryWaitSeconds(held(quick), 0), quick);
  // And still strictly below the next hint up, so widening cannot swallow a refusal owed the card.
  assert.ok(SILENT_RETRY_MAX_SECONDS < 20, "20s is a missing outside reference and must still show");
});

test("a wait long enough to mean the CHAIN is retried by nobody - that card is honest", () => {
  // 20s is a missing outside reference, 75s is genuinely behind. Neither clears because we asked
  // again, and hiding them behind a spinner would be a lie with a nicer animation.
  assert.equal(silentRetryWaitSeconds(held(20), 0), null);
  assert.equal(silentRetryWaitSeconds(held(75), 0), null);
  // The boundary is a statement about cause, so it is pinned rather than left to drift.
  assert.equal(silentRetryWaitSeconds(held(SILENT_RETRY_MAX_SECONDS), 0), SILENT_RETRY_MAX_SECONDS);
  assert.equal(silentRetryWaitSeconds(held(SILENT_RETRY_MAX_SECONDS + 1), 0), null);
});

test("a refusal that names itself is never a wobble, whatever wait it carries", () => {
  // Each of these has its own card and its own sentence. Retrying past one would hide something
  // the visitor needs to act on - a daily cap does not clear in five seconds.
  for (const kind of ["cap", "busy", "sends", "restarting"]) {
    assert.equal(silentRetryWaitSeconds({ status: 503, kind, retryAfterSeconds: 5 }, 0), null, kind);
  }
});

test("only a 503 - a 429 cooldown or a 400 is the visitor's to see at once", () => {
  for (const status of [200, 400, 403, 429, 502, 504]) {
    assert.equal(silentRetryWaitSeconds({ status, retryAfterSeconds: 5 }, 0), null, String(status));
  }
});

test("a spinner that never resolves is worse than an error, so it stops at the cap", () => {
  assert.equal(silentRetryWaitSeconds(held(5), SILENT_RETRY_CAP - 1), 5);
  assert.equal(silentRetryWaitSeconds(held(5), SILENT_RETRY_CAP), null);
  assert.equal(silentRetryWaitSeconds(held(5), SILENT_RETRY_CAP + 9), null);
});

test("a wait that is not a usable number is not a wait", () => {
  // The reply is a stranger's JSON until it is checked, and a missing or nonsense hint must not
  // become an immediate hammering retry.
  for (const bad of [undefined, null, 0, -5, NaN, Infinity, "5", {}, []]) {
    assert.equal(silentRetryWaitSeconds(held(bad), 0), null, JSON.stringify(bad));
  }
});

test("the card accounts for the seconds already spent, rather than implying it just failed", () => {
  assert.equal(retriesExhaustedNote(0), "");
  assert.match(retriesExhaustedNote(1), /once/);
  assert.match(retriesExhaustedNote(2), /2 times/);
});

test("the extra step says WHY, not that a retry is happening", () => {
  // "Retrying" tells a visitor we are doing something again without telling them why, and the why
  // is the part that stops it reading as a fault of theirs.
  assert.doesNotMatch(RETRY_STEP_LABEL, /^retry/i);
  assert.match(RETRY_STEP_LABEL, /node/i);
});
