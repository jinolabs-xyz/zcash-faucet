/**
 * Ask the Crosslink node how current it is, and hand the answer to the pure gate.
 *
 * Split from recency.ts the way miner/read.ts is split from miner/heartbeat.ts: the
 * rules stay pure and reachable in a test with no node, and the one function that
 * needs a network lives here on its own.
 *
 * EVERY FAILURE IS cannot-verify, never not-activated and never ready. A node that
 * will not answer has not told us TFL is off, and it has certainly not told us it is
 * current. The one exception is their own "not activated" error, which IS an answer.
 */
import { config } from "../config.ts";
import { readingFor, notActivated, type CtazReading } from "./recency.ts";

/** Short. This sits in front of a claim, and a slow node should read as unavailable
 *  rather than hold someone's request open. */
const TIMEOUT_MS = 4000;

export async function readCtazRecency(nowMs: number = Date.now()): Promise<CtazReading> {
  if (!config.crosslink.enabled || !config.crosslink.rpcUrl) return readingFor(null, nowMs);
  try {
    const res = await fetch(config.crosslink.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_tfl_recency_status", params: [] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return readingFor(null, nowMs);
    const reply = (await res.json()) as { result?: unknown; error?: { message?: string } };
    // Their node answers TFL-off as an error rather than as a status, so this is the
    // one error that carries information. Matched on the message because that is what
    // the spike observed; anything else stays cannot-verify.
    if (reply.error) {
      return /not activated/i.test(reply.error.message ?? "") ? notActivated() : readingFor(null, nowMs);
    }
    return readingFor(reply.result, nowMs);
  } catch {
    return readingFor(null, nowMs);
  }
}
