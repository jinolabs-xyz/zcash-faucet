/**
 * The independent chain's hash at a height we choose — the half of the fork detector the APP
 * can see (#533, risk register R-20).
 *
 * WHY THIS EXISTS AND WHY IT IS ONLY HALF. `node.chain` has read `cannot-verify` on production
 * since it shipped: the rules half asks zallet for `getblockchaininfo`, and zallet exposes no
 * such method — measured on the box, it answers `Method not found (-32601)`. So `ourBranchId()`
 * is null for ever and nothing compares anything.
 *
 * The honest shape is split across the two processes that can each see one side:
 *   HERE:         their hash at a height, from lightwalletd over gRPC, which the app already dials
 *   THE WATCHDOG: our hash at that height, from zebra's own RPC via `docker exec` and the cookie
 *                 in the zebra container — which the app cannot reach from its own container
 * The watchdog compares them and pages on a MISMATCH. That is "fail on proof, not on
 * cannot-verify", in the process that has the proof.
 *
 * WHAT THIS FILE MUST NOT DO: refuse drips. A reference we could not fetch is not a fork, and the
 * AHEAD branch of the freshness gate stays exactly as it is — the register's stopgap (cap
 * `lag < -3` as unverifiable) would have taken the faucet down, measured at lag -4 to -8 on a
 * production node legitimately ahead of the oracle, and -59 during one bad oracle hour.
 */
import * as grpc from "@grpc/grpc-js";
import { targetFor } from "./grpcTarget.ts";

/**
 * How far below the tip to ask. A reorg of a few blocks is ORDINARY and is not a fork, so a
 * comparison at the tip would page on normal chain behaviour — the failure mode that makes an
 * alarm get switched off. Ten is comfortably past any reorg we have seen and still recent enough
 * that a divergence is worth waking someone for.
 */
export const REFERENCE_DEPTH = 10;

/** A BlockID carrying only a height: field 1, varint. */
export function encodeBlockIDHeight(height: number): Buffer {
  const out = [0x08];
  let v = BigInt(Math.floor(height));
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return Buffer.from(out);
}

/**
 * The `hash` out of a CompactBlock: field 3, length-delimited.
 *
 * RETURNED IN DISPLAY ORDER, REVERSED FROM THE WIRE, and this is the detail that would otherwise
 * produce a confident false FORK. lightwalletd sends the hash in internal byte order; zebra's
 * `getblockhash` — which the watchdog will compare this against — prints display order, the
 * reverse. Two correct systems, two orderings, and a comparison between them that never matches.
 * Reversed here rather than in the watchdog so there is ONE place that knows, next to the decoder
 * that produced the bytes.
 */
export function hashFromCompactBlock(buf: Buffer): string | null {
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i++]!;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      let len = 0, s = 0;
      for (;;) {
        if (i >= buf.length) return null;
        const b = buf[i++]!;
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (i + len > buf.length) return null;
      if (field === 3) {
        // 32 bytes or it is not a block hash, whatever the field number says.
        if (len !== 32) return null;
        return Buffer.from(buf.subarray(i, i + len)).reverse().toString("hex");
      }
      i += len;
      continue;
    }
    if (wire === 0) {
      for (;;) { if (i >= buf.length) return null; if (!(buf[i++]! & 0x80)) break; }
      continue;
    }
    if (wire === 5) { i += 4; continue; }
    if (wire === 1) { i += 8; continue; }
    return null; // a wire type we do not know: stop rather than guess at the layout
  }
  return null;
}

/** One GetBlock against an endpoint. Null on any failure — a reference we could not fetch is
 *  not a fork, and this must never be the reason a drip is refused. */
export function dialBlockHash(endpoint: string, height: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const { target, creds } = targetFor(endpoint);
      const client = new grpc.Client(target, creds);
      client.makeUnaryRequest(
        "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlock",
        (x: Buffer) => x,
        (x: Buffer) => x,
        encodeBlockIDHeight(height),
        new grpc.Metadata(),
        { deadline: new Date(Date.now() + timeoutMs) },
        (err, res) => {
          client.close();
          finish(err || !res ? null : hashFromCompactBlock(res));
        },
      );
    } catch {
      finish(null);
    }
  });
}
