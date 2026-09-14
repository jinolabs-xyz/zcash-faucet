/**
 * Who may read the operator's view of /api/status (risk register II, R-24).
 *
 * The public page and the off-box probe read the same endpoint. Some of what it can
 * say is for the operator only: which fault the box has (a stopped watchdog, a pager
 * that reaches nobody) and which commit is running, since "the box is three commits
 * behind main" is a list of unlanded fixes. So those fields come back only to a request
 * carrying FAUCET_OPS_TOKEN in the x-faucet-ops header; everyone else gets one word.
 *
 * No token configured means nobody gets the detail from outside: the safe default, and
 * the operator still has the box's own report and the Signal page.
 */
import { timingSafeEqual } from "node:crypto";

export const OPS_HEADER = "x-faucet-ops";

/** Constant-time on the bytes; a wrong length is a plain no, the way pow.ts does it. */
export function opsTokenMatches(presented: string | null, configured: string | undefined): boolean {
  if (!configured || configured.length < 16 || !presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
