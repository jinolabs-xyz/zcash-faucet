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
import { ctazRpc } from "./transport.ts";
import { readingFor, notActivated, type CtazReading } from "./recency.ts";
import { readCtazStatusFile, statusIsStale } from "./statusFile.ts";

/** Short. This sits in front of a claim, and a slow node should read as unavailable
 *  rather than hold someone's request open. */
/** One place the transport is described, so the two readers cannot drift apart. */
function transport() {
  return {
    socketPath: config.crosslink.rpcSocket,
    rpcUrl: config.crosslink.rpcUrl,
    timeoutMs: config.crosslink.rpcTimeoutMs,
  };
}

/**
 * What the page shows about the node, which is MORE than the gate classifies on.
 *
 * `syncPercent` sits BESIDE the verdict and never inside it. The five states answer "can we
 * serve", and a syncing node simply cannot, so there is no "syncing" state by design.
 * Folding a percent into a readiness verdict is how "23% synced" and "cannot reach the
 * node" end up rendering the same, which is the ambiguity those five states exist to
 * prevent. It is passed through, never classified on, exactly like enabledUndeclared.
 */
export interface CtazNodeState {
  reading: CtazReading;
  syncPercent: number | null;
  blocks: number | null;
  tip: number | null;
  /** Where the answer came from, so the panel can say "stale file" rather than implying
   *  the node itself is unreachable. Different fixes: one is the writer, one is the node. */
  source: "file" | "rpc" | "none";
}

/**
 * THE FILE IS THE PRODUCTION PATH and the RPC is the local one.
 *
 * File first, because in the container the RPC cannot work at all and trying it first would
 * spend a 4s timeout on every status request to learn that again. RPC second, because a
 * developer running this on a host WITH the node reachable should not need to run the
 * writer script to see anything.
 *
 * A STALE FILE IS cannot-verify, NOT the last thing it said. That is the whole reason the
 * timestamp is written: a file nobody is refreshing describes a node that may have died
 * ten minutes ago, and reporting its last known state as current is how a green page
 * outlives the thing it describes.
 */
export async function readCtazNodeState(nowMs: number = Date.now()): Promise<CtazNodeState> {
  const none = { reading: readingFor(null, nowMs), syncPercent: null, blocks: null, tip: null };
  if (!config.crosslink.enabled) return { ...none, source: "none" };

  const f = readCtazStatusFile(config.crosslink.statusFile);
  if (f.at != null) {
    // The file exists and parses, so it IS the answer, including when the answer is bad.
    // Falling through to the RPC here would be worse than useless: it cannot work in the
    // container, so it would replace a specific "the writer is stale" with a generic
    // "cannot verify" and lose the only clue about which half is broken.
    if (statusIsStale(f, nowMs)) return { ...none, source: "file" };
    if (!f.readable) return { ...none, source: "file" };
    return {
      reading: readingFor(f.recency, nowMs),
      syncPercent: f.syncPercent,
      blocks: f.blocks,
      tip: f.tip,
      source: "file",
    };
  }

  // No file at all: a dev host, or cTAZ enabled before the writer was installed.
  //
  // getinfo AS WELL AS the recency status, and the reason is a regression I shipped. The
  // sync gate needs blocks AND tip, and the first version of this path returned tip: null,
  // so canServeCtaz refused every claim on the RPC path while passing on the file path.
  // Every local check I ran used the file, so I verified the configuration I had built
  // rather than the one CI uses, and CI caught it. Both paths must supply both figures or
  // the gate is not the same gate.
  const reading = await readCtazRecency(nowMs);
  const info = await readCtazInfo();
  return {
    reading,
    syncPercent:
      info.blocks != null && info.tip != null && info.tip > 0
        ? Math.min(100, Math.round((info.blocks / info.tip) * 1000) / 10)
        : null,
    blocks: info.blocks ?? reading.height,
    tip: info.tip,
    source: "rpc",
  };
}

/**
 * The node's sync position over RPC. Nulls on every failure, never zeros: an unread tip
 * must refuse at the gate rather than look like a caught-up node.
 */
async function readCtazInfo(): Promise<{ blocks: number | null; tip: number | null }> {
  const none = { blocks: null, tip: null };
  // getblockchaininfo, NOT getinfo, and that is measured rather than assumed. This build's
  // getinfo returns twelve fields and none of them is a tip - the same trap ctaz-status.sh
  // documents, which had the panel reading "sync unknown" on a node sitting at the tip.
  const { reply } = await ctazRpc(transport(), "getblockchaininfo");
  if (!reply || reply.error) return none;
  const r = reply.result as { blocks?: unknown; estimatedheight?: unknown; headers?: unknown } | undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // estimatedheight is zebra's own guess at the network tip while it catches up. Falling
  // back to blocks would make any node look synced by definition, so it does not.
  return { blocks: n(r?.blocks), tip: n(r?.estimatedheight) ?? n(r?.headers) };
}

export async function readCtazRecency(nowMs: number = Date.now()): Promise<CtazReading> {
  if (!config.crosslink.enabled) return readingFor(null, nowMs);
  {
    const { reply } = await ctazRpc(transport(), "get_tfl_recency_status");
    if (!reply) return readingFor(null, nowMs);
    // Their node answers TFL-off as an error rather than as a status, so this is the
    // one error that carries information. Matched on the message because that is what
    // the spike observed; anything else stays cannot-verify.
    if (reply.error) {
      return /not activated/i.test(reply.error.message ?? "") ? notActivated() : readingFor(null, nowMs);
    }
    return readingFor(reply.result, nowMs);
  }
}
