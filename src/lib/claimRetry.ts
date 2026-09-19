/**
 * WHETHER A REFUSAL IS OUR OWN WOBBLE, AND THEREFORE WORTH HIDING FROM THE VISITOR.
 *
 * The owner asked for a silent retry with a visible step: "show the user that this is happening
 * with one more green circle". This is the decision half - which refusals qualify, how long to
 * wait, and when to stop - kept out of the component so it can be asserted directly instead of by
 * driving a browser through three refusals to read a colour.
 *
 * ONLY OUR OWN WOBBLE, AND THE SERVER ALREADY SAYS WHICH. /api/faucet answers a freshness refusal
 * with a wait chosen by the cause: 5s when OUR node did not answer in time, 20s when an outside
 * reference is missing, 75s when we are genuinely behind the chain. Only the first is a failure
 * that clears by itself in seconds - measured on production, eight status reads in ten came back
 * under 3s while the node was fully synced. A block has to pass for the 75s case and a card that
 * says so is honest; hiding it behind a spinner would be a lie with a nicer animation.
 *
 * SO THE THRESHOLD IS A STATEMENT ABOUT CAUSE, NOT A TUNING KNOB. "Short enough that the next read
 * is likely to succeed" is what 5 means, and if the server ever changes which causes get which
 * wait, this is the line that has to move with it.
 *
 * AND IT IS CAPPED, BECAUSE A SPINNER THAT NEVER RESOLVES IS WORSE THAN AN ERROR. Two silent
 * retries, then the card - and the card says the retries happened, so a visitor who waited 10
 * seconds is not told the request only just failed.
 */

/**
 * A hint at or below this means "our own read wobbled". Above it, the wait is about the chain or
 * an outside reference and the visitor is owed the card instead of a spinner.
 *
 * TEN, NOT FIVE, AND THE DIFFERENCE IS A CONTRACT RATHER THAN A PREFERENCE. The server picks the
 * wobble hint in `freshness-retry.ts` and today it returns 5 - but its own test asserts only
 * `quick <= 10`, so 6, 8 or 10 would keep that suite green. At a threshold of 5 any such change
 * would silently switch this whole feature off: the page would stop retrying, no row on either
 * side would fail, and the first anyone knew would be a visitor being refused for our wobble
 * again. Matching the bound the server's test actually guarantees is what stops two green suites
 * from disagreeing.
 *
 * It stays well clear of the other two hints - 20s for a missing outside reference, 75s for
 * genuinely behind - and the server's own test pins those as strictly greater, so widening to 10
 * cannot start hiding a refusal that deserves the card.
 */
export const SILENT_RETRY_MAX_SECONDS = 10;

/** How many times we quietly try again before the refusal becomes the visitor's problem. */
export const SILENT_RETRY_CAP = 2;

export interface ClaimRefusal {
  status: number;
  /** The server's discriminator, when it sends one: "cap", "busy", "sends", "restarting". */
  kind?: unknown;
  retryAfterSeconds?: unknown;
}

/**
 * How long to wait before quietly trying again, or null to stop and show the refusal.
 *
 * Returns the WAIT rather than a boolean so the caller cannot invent its own interval: the server
 * chose that number from the cause, and a client that retried on its own schedule would be
 * hammering a backend that is slow precisely because it is busy.
 */
export function silentRetryWaitSeconds(refusal: ClaimRefusal, attemptsSoFar: number): number | null {
  if (refusal.status !== 503) return null;
  if (attemptsSoFar >= SILENT_RETRY_CAP) return null;
  // A refusal that names itself is never a wobble: "cap" is the daily limit, "busy" is a full
  // queue, "sends" is a degraded wallet, "restarting" is a deploy. Each has its own card and its
  // own sentence, and retrying past any of them would hide something the visitor needs.
  if (typeof refusal.kind === "string" && refusal.kind.length > 0) return null;
  const wait = refusal.retryAfterSeconds;
  if (typeof wait !== "number" || !Number.isFinite(wait)) return null;
  if (wait <= 0 || wait > SILENT_RETRY_MAX_SECONDS) return null;
  return wait;
}

/**
 * The fifth circle, and it exists only while the retry is happening.
 *
 * The owner asked for "one MORE green circle" - a list that GROWS an item when something goes
 * wrong, not a permanently dimmed fifth step that spends the whole happy path hinting at a
 * failure. So this label is appended, never reserved.
 *
 * It says what happened rather than that a retry is occurring: "Retrying" tells a visitor we are
 * doing something again without telling them why, and the why is the part that stops it reading
 * as a fault of theirs.
 */
export const RETRY_STEP_LABEL = "Our node was slow, asking it again";

/** What the card says once the retries are spent, so the wait is accounted for rather than hidden. */
export function retriesExhaustedNote(attempts: number): string {
  if (attempts <= 0) return "";
  return attempts === 1
    ? " We already tried again once."
    : ` We already tried again ${attempts} times.`;
}
