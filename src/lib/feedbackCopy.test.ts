import { test } from "node:test";
import assert from "node:assert/strict";
import { feedbackSentence, QUEUED_SENTENCE, OFFLINE_SENTENCE, type FeedbackKind } from "./feedbackCopy.ts";
import { MAX_FEEDBACK_BODY } from "./feedbackLimits.ts";

const FAILURES: FeedbackKind[] = ["empty", "too-long", "rate", "ledger", "bad-request"];
const everything = [QUEUED_SENTENCE, OFFLINE_SENTENCE, ...FAILURES.map((k) => feedbackSentence(k, undefined, MAX_FEEDBACK_BODY))];

test("nothing the form can say claims the message reached anyone", () => {
  // THE PROPERTY THE WHOLE FEATURE TURNS ON. The endpoint answers 202 before delivery, so a
  // sentence asserting it was sent or delivered would be the page claiming more than it knows -
  // the same fault as "100% accepted by our node" and "0 on a day nobody counted", in copy.
  // Written as "no sentence asserts it" rather than "no sentence contains the word", because
  // "has not been delivered yet" is a DENIAL and must stay legal.
  for (const s of everything) {
    assert.doesNotMatch(s, /\b(was|has been|is) (sent|delivered)\b/i, `claims delivery: ${s}`);
    assert.doesNotMatch(s, /\bwe(?:'ve| have) (sent|delivered)\b/i, `claims delivery: ${s}`);
  }
});

test("and the success sentence says received, which is the most it may claim", () => {
  assert.match(QUEUED_SENTENCE, /^Received\./);
  // The denial is load-bearing: without it "Received" alone reads as "it arrived".
  assert.match(QUEUED_SENTENCE, /not been delivered yet/);
});

test("every failure kind gets its own sentence, so none of them is a shrug", () => {
  const said = FAILURES.map((k) => feedbackSentence(k, undefined, MAX_FEEDBACK_BODY));
  // bad-request shares the default with unknown kinds deliberately; the other four must differ
  // from it and from each other, or route.ts distinguishing them bought nothing.
  const distinct = new Set(said);
  assert.equal(distinct.size, FAILURES.length, `sentences collapsed: ${JSON.stringify(said)}`);
});

test("an unrecognised kind falls back rather than throwing or leaking the kind", () => {
  const s = feedbackSentence("something-we-never-shipped", undefined, MAX_FEEDBACK_BODY);
  assert.equal(s, feedbackSentence("bad-request", undefined, MAX_FEEDBACK_BODY));
  assert.doesNotMatch(s, /something-we-never-shipped/);
});

test("too-long says the server's number when it gives one, and ours when it does not", () => {
  assert.match(feedbackSentence("too-long", 5000, MAX_FEEDBACK_BODY), /5,000 characters/);
  assert.match(feedbackSentence("too-long", undefined, MAX_FEEDBACK_BODY), /2,000 characters/);
  // A nonsense value from a stranger's response must not reach the reader as a nonsense sentence.
  assert.match(feedbackSentence("too-long", -1, MAX_FEEDBACK_BODY), /2,000 characters/);
  assert.match(feedbackSentence("too-long", "lots", MAX_FEEDBACK_BODY), /2,000 characters/);
});

test("the two that keep what was written say so, because that is what stops a retry losing it", () => {
  for (const k of ["ledger", "bad-request"] as FeedbackKind[]) {
    assert.match(feedbackSentence(k, undefined, MAX_FEEDBACK_BODY), /still here/);
  }
  // The rate case is the opposite and must NOT promise it is kept: nothing was stored.
  assert.match(feedbackSentence("rate", undefined, MAX_FEEDBACK_BODY), /was not stored/);
});
