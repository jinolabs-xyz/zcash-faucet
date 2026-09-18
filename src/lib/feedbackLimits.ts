/**
 * The feedback form's limits, in one place because TWO SIDES NEED THEM.
 *
 * `@/lib/db` owns the enforcement and answers with these numbers; the browser form has to know
 * the same ones to set `maxLength` and to count down the last characters. Importing `@/lib/db`
 * into a client component would pull better-sqlite3 and the whole ledger into the browser
 * bundle, and retyping 2000 in a .tsx is the untied-constant shape this repo keeps finding - the
 * two copies agree until someone changes one. So the values live here, the db layer re-exports
 * them, and there is exactly one definition to change.
 *
 * No imports, no side effects: this file has to be safe on both sides of the boundary.
 */

/** Longer than this is truncated by nobody: the request is refused and says so. */
export const MAX_FEEDBACK_BODY = 2000;
/** A contact string someone chose to give us. Never parsed, never trusted, never required. */
export const MAX_FEEDBACK_REPLY_TO = 200;
/** Per fingerprint, per day. Low: this is a feedback form, not a chat. */
export const FEEDBACK_PER_DAY = 5;
/** Rows are deleted after this whether or not they were ever delivered. */
export const FEEDBACK_RETENTION_SECONDS = 30 * 86_400;
