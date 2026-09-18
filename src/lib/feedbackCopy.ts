/**
 * What the feedback form says, as a decision rather than as markup.
 *
 * Same split the charts use: the thing with a right answer is a pure function here, and the
 * component renders what it returns. A sentence rendered inline in a .tsx can only be checked by
 * driving a browser, and the property that matters most - that none of these ever claims the
 * message reached the operator - is a property of the STRINGS, so it belongs where a test can
 * hold all of them at once.
 *
 * THE RULE THEY ALL OBEY: /api/feedback answers 202 after writing a row, and a timer on the box
 * hands it on separately. At the moment any of these sentences is shown, nothing has been
 * delivered. "Received" is the most any of them may claim.
 */

/** The kinds /api/feedback distinguishes. Anything else is a stranger's response, not ours. */
export type FeedbackKind = "queued" | "empty" | "too-long" | "rate" | "ledger" | "bad-request";

/** The 202. The one sentence allowed to sound like success, and it still does not claim delivery. */
export const QUEUED_SENTENCE = "Received. It is queued for the operator and has not been delivered yet.";

/**
 * One sentence per failure, because route.ts went to the trouble of telling them apart.
 *
 * Collapsing them into "something went wrong" would throw that away at the last step: a person who
 * hit the daily limit and a person whose message is too long have to do different things next, and
 * only one of them should try again now.
 *
 * `maxBody` comes from the response rather than from our own constant, so a server that raises the
 * limit says the new number without a redeploy of this file - and falls back to ours when it does
 * not say.
 */
export function feedbackSentence(kind: unknown, maxBody: unknown, fallbackMax: number): string {
  switch (kind) {
    case "empty":
      return "There was nothing in the message - write something first.";
    case "too-long": {
      const n = typeof maxBody === "number" && Number.isFinite(maxBody) && maxBody > 0 ? maxBody : fallbackMax;
      return `That is longer than this form takes (${n.toLocaleString("en-US")} characters). Shorten it and try again.`;
    }
    case "rate":
      return "That is the limit for one day. Your message was not stored - try again tomorrow.";
    case "ledger":
      return "The faucet could not store it. Your message is still here - try again in a moment.";
    default:
      // Includes "bad-request" and anything unrecognised. Never a stack trace, never a kind name:
      // neither tells a visitor what to do, and the second leaks our vocabulary.
      return "That did not go through. Your message is still here - try again in a moment.";
  }
}

/** The unreachable-network case, which is not the endpoint refusing and should not read like it. */
export const OFFLINE_SENTENCE = "The faucet could not be reached. Your message is still here - try again in a moment.";
