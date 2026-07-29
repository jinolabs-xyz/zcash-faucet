/**
 * An independent view of the network tip, from a public lightwalletd we do NOT
 * run. This is the antidote to the failure that killed Fauzec's faucet (#170):
 * a node that has silently stopped following the chain keeps reporting its own
 * frozen tip as the tip, so any readiness check that trusts our own node is
 * fooled. Comparing our node's tip against a DIFFERENT node's tip is the only
 * way to notice we have diverged from reality.
 *
 * lightwalletd speaks gRPC (cash.z.wallet.sdk.rpc.CompactTxStreamer). Its
 * GetLatestBlock takes an empty ChainSpec and returns a BlockID:
 *   message BlockID { uint64 height = 1; bytes hash = 2; }
 * We only need field 1, so we hand-parse the one varint rather than bundle the
 * whole .proto into the Next build. The wire format: each field is a tag byte
 * (field_number << 3 | wire_type) followed by the value; field 1 is wire_type 0
 * (varint), field 2 is wire_type 2 (length-delimited), which we skip.
 */
import * as grpc from "@grpc/grpc-js";
import { config } from "../config.ts";

/** Pull the height (field 1 varint) out of a serialized BlockID. */
export function heightFromBlockID(buf: Buffer): number | null {
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i++]!;
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) {
      let v = 0n;
      let shift = 0n;
      for (;;) {
        const b = buf[i++]!;
        v |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7n;
      }
      return Number(v);
    }
    // Skip any field that is not the height we want.
    if (wire === 2) {
      let len = 0;
      let s = 0;
      for (;;) {
        const b = buf[i++]!;
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      i += len;
    } else if (wire === 0) {
      while (buf[i++]! & 0x80);
    } else {
      break; // wire types we do not expect; stop rather than misread
    }
  }
  return null;
}

function getLatestBlock(host: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const client = new grpc.Client(host, grpc.credentials.createSsl());
    client.makeUnaryRequest(
      "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock",
      (x: Buffer) => x,
      (x: Buffer) => x,
      Buffer.alloc(0),
      new grpc.Metadata(),
      { deadline: new Date(Date.now() + timeoutMs) },
      (err, res) => {
        client.close();
        if (err) reject(err);
        else resolve(res ? heightFromBlockID(res) : null);
      },
    );
  });
}

/**
 * Primary source: the hosh network-health dashboard aggregates the tip across
 * every public testnet lightwalletd and publishes it as plain JSON. Taking the
 * max height over the online testnet servers is more robust than trusting one
 * node — a single lagging server cannot make us think we are behind, and the
 * dashboard exists precisely to answer "where is the network right now".
 */
const HOSH_URL = process.env.HOSH_URL ?? "https://hosh.zec.rocks/api/v0/zec.json";

async function fromHosh(timeoutMs: number): Promise<number | null> {
  const res = await fetch(HOSH_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const json = (await res.json()) as { servers?: { chain?: string; online?: boolean; height?: number }[] };
  const heights = (json.servers ?? [])
    .filter((s) => s.chain === "test" && s.online && typeof s.height === "number")
    .map((s) => s.height!);
  return heights.length ? Math.max(...heights) : null;
}

let cache: { height: number; at: number } | null = null;
const CACHE_MS = 30_000; // don't hammer the public endpoints on every /api/ready

/**
 * The network tip according to sources that are NOT our own node. Tries the
 * aggregated hosh dashboard first, then falls back to a direct GetLatestBlock
 * against each configured lightwalletd. Returns null only when EVERY independent
 * source is unreachable — that is "cannot verify freshness", NOT "we are
 * healthy": the caller must not treat null as a pass (#75 not-seen vs cannot-say).
 */
export async function getExternalTip(): Promise<number | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.height;

  try {
    const h = await fromHosh(5000);
    if (h != null && h > 0) {
      cache = { height: h, at: Date.now() };
      return h;
    }
  } catch {
    // hosh down — fall back to a direct node below
  }

  for (const endpoint of config.lightwalletdEndpoints) {
    try {
      const host = new URL(endpoint).host; // e.g. "testnet.zec.rocks:443"
      const h = await getLatestBlock(host, 5000);
      if (h != null && h > 0) {
        cache = { height: h, at: Date.now() };
        return h;
      }
    } catch {
      // try the next endpoint
    }
  }
  return null;
}
