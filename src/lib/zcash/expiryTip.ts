/**
 * The tip a TRANSPARENT send stamps its expiry from (#190).
 *
 * #187 gated the zallet path on our own node's freshness, because zallet stamps
 * expiry_height from its node's tip and a lagging node produces a transaction that
 * is born expired. That scoping was right and it relocated the hazard rather than
 * removing it: realsend and t2zsend read the tip from lightwalletd, so a lagging
 * lightwalletd produces the identical doomed transaction from a different source.
 *
 * THE ASYMMETRY THAT DECIDES THE DESIGN, and it is why "take the max" here is a
 * correctness argument rather than a heuristic:
 *
 *   under-estimate the tip  ->  expiry_height is in the network's past, the
 *                               transaction can never be mined at any fee, and on
 *                               2026-07-29 that cost us a 7-hour crash loop
 *   over-estimate the tip   ->  expiry_height is further away, so the transaction
 *                               simply has longer to confirm
 *
 * Only one direction kills. Every source we ask can lag, none can be usefully
 * ahead of the real chain, so the highest height any of them reports is the closest
 * thing to the truth available and it errs in the survivable direction.
 *
 * So this asks EVERY configured endpoint concurrently and takes the max, where
 * grpc.ts's callFirst() takes whichever answers first. First-to-answer is the wrong
 * selector for this question: the fastest endpoint has no reason to be the most
 * current, and a single lagging server that happens to be quick is exactly the #190
 * failure. Nothing else in grpc.ts changes, because failover-to-first is correct for
 * the balance and UTXO reads where any honest answer will do.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: refuse. See the comment on `disagreement`.
 */
import * as grpc from "@grpc/grpc-js";
import { config } from "../config.ts";
import { EXPIRY_DELTA_BLOCKS, SHIELD_MAX_LAG_BLOCKS } from "./shieldGate.ts";
import { heightFromBlockID } from "./externalTip.ts";

/** Per-endpoint deadline. They run concurrently, so this is also the total. */
const TIP_TIMEOUT_MS = 6000;

export interface EndpointTip {
  endpoint: string;
  height: number | null;
}

export interface ExpiryTip {
  /** Highest height any endpoint reported. Null when none answered at all. */
  height: number | null;
  /** Every endpoint we asked and what it said, for logging and for tests. */
  readings: readonly EndpointTip[];
  /** How many gave a usable height. One is the #190 condition, unimproved. */
  answered: number;
  /** max - min across answering endpoints. Null with fewer than two. */
  spread: number | null;
}

/** One GetLatestBlock, hand-parsed like externalTip does, null on any failure. */
function askOne(endpoint: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const url = new URL(endpoint);
    const tls = url.protocol === "https:" || url.port === "443" || url.port === "";
    const target = `${url.hostname}:${url.port || (tls ? "443" : "9067")}`;
    const client = new grpc.Client(
      target,
      tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
    );
    client.makeUnaryRequest(
      "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock",
      (x: Buffer) => x,
      (x: Buffer) => x,
      Buffer.alloc(0),
      new grpc.Metadata(),
      { deadline: new Date(Date.now() + timeoutMs) },
      (err, res) => {
        client.close();
        // Resolve rather than reject: one dead endpoint is a data point, not an
        // error, and Promise.all over rejections would lose the others' answers.
        resolve(err || !res ? null : heightFromBlockID(res));
      },
    );
  });
}

/**
 * The pure part: given what each endpoint said, what tip do we stamp and what is
 * worth saying about it. Separated from the network exactly as decide.ts and
 * chainFreshness are, so every branch below is reachable in a test without a
 * socket, including the ones that only happen when public infrastructure is down.
 */
export function summarize(readings: readonly EndpointTip[]): ExpiryTip {
  const heights = readings.map((r) => r.height).filter((h): h is number => h != null && h > 0);
  return {
    height: heights.length ? Math.max(...heights) : null,
    readings,
    answered: heights.length,
    spread: heights.length >= 2 ? Math.max(...heights) - Math.min(...heights) : null,
  };
}

/**
 * What is worth telling an operator, or null when everything looks fine.
 *
 * This REPORTS and does not refuse, which is a deliberate departure from the
 * zallet gate next door, and the reason is worth writing down because "be
 * consistent" points the wrong way here.
 *
 * The obvious stronger design is to cross-check this tip against getExternalTip()
 * and refuse when they disagree. That check can LIE. getExternalTip's primary
 * source is hosh, but when hosh is down it degrades to a direct GetLatestBlock over
 * `config.lightwalletdEndpoints` — the very list we just asked. So in the exact
 * conditions where corroboration matters most, the check compares a source against
 * itself, agrees with itself, and reports a verdict it never established. That is
 * the same false-pass class as two empty sha256sum listings comparing equal, and
 * shipping it would be worse than shipping nothing because it reads as verified.
 *
 * Making it honest needs getExternalTip to carry its provenance so a caller can
 * tell an aggregate from a same-source fallback. That is real work, it touches the
 * oracle every other check reads, and its only gain over max-of-all-endpoints is
 * the case where every source lags together, which NEITHER approach detects. So it
 * is filed rather than guessed at, and this function makes the condition visible in
 * the meantime instead of asserting something it cannot know.
 */
export function disagreement(tip: ExpiryTip): string | null {
  if (tip.answered === 0) return null; // the caller is about to fail anyway
  if (tip.answered === 1) {
    const which = tip.readings.find((r) => r.height != null)?.endpoint ?? "unknown";
    return (
      `only ${which} answered, so the expiry height rests on ONE source and a lag there ` +
      `would produce a born-expired transaction with nothing to contradict it (#190)`
    );
  }
  // A spread wider than the build budget means at least one member is far enough
  // behind to matter. Reported even though we used the max, because the max being
  // right does not make a lagging endpoint in the rotation harmless: every other
  // read in grpc.ts still takes whichever answers first.
  if (tip.spread != null && tip.spread > SHIELD_MAX_LAG_BLOCKS) {
    const behind = tip.readings
      .filter((r) => r.height != null && r.height < tip.height!)
      .map((r) => `${r.endpoint} at ${r.height}`)
      .join(", ");
    return (
      `lightwalletd endpoints disagree by ${tip.spread} blocks (budget ${SHIELD_MAX_LAG_BLOCKS}, ` +
      `expiry dies at ${EXPIRY_DELTA_BLOCKS}); using ${tip.height} but ${behind} is behind`
    );
  }
  return null;
}

/**
 * Ask every configured endpoint and return the tip to stamp.
 *
 * Throws only when nothing answered, matching what callFirst() already does on the
 * same condition, so a caller's failure path does not change shape.
 */
export async function tipForExpiry(timeoutMs = TIP_TIMEOUT_MS): Promise<ExpiryTip> {
  const endpoints = config.lightwalletdEndpoints;
  const readings = await Promise.all(
    endpoints.map(async (endpoint) => ({ endpoint, height: await askOne(endpoint, timeoutMs) })),
  );
  const tip = summarize(readings);

  const note = disagreement(tip);
  if (note) console.warn(`[expiryTip] ${note}`);

  if (tip.height == null) {
    throw new Error(
      `No lightwalletd endpoint reported a tip, so a transaction's expiry height cannot be ` +
        `set safely (asked ${endpoints.length}: ${endpoints.join(", ")}).`,
    );
  }
  return tip;
}
