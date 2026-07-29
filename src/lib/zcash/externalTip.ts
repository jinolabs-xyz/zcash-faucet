/**
 * An independent view of the network tip, from public light-wallet infrastructure
 * we do NOT run. This is the antidote to the failure that killed Fauzec's faucet
 * (#170): a node that has silently stopped following the chain keeps reporting
 * its own frozen tip as the tip, so any readiness check that trusts our own node
 * is fooled. Comparing our node's tip against a DIFFERENT view is the only way to
 * notice we have diverged from reality. We depend on nobody for money — this is
 * verification only.
 *
 * IMPORTANT: this must never be on the readiness critical path. A public endpoint
 * being slow would otherwise make /api/ready slow, which trips the watchdog's and
 * redeploy's curl timeouts and turns a third-party blip into a false page or an
 * auto-rollback of a good deploy. So the network work happens on a background
 * refresh and readers only ever read the last-known cached value, synchronously.
 *
 * lightwalletd speaks gRPC (cash.z.wallet.sdk.rpc.CompactTxStreamer). Its
 * GetLatestBlock takes an empty ChainSpec and returns a BlockID:
 *   message BlockID { uint64 height = 1; bytes hash = 2; }
 * We only need field 1, so we hand-parse the one varint rather than bundle the
 * whole .proto into the Next build.
 */
import * as grpc from "@grpc/grpc-js";
import { config } from "../config.ts";

/**
 * Pull the height (field 1 varint) out of a serialized BlockID. Returns null on
 * anything malformed or truncated — never a fabricated number, so a partial read
 * cannot masquerade as a real (smaller) height and quietly say "not frozen".
 */
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
        if (i >= buf.length) return null; // varint ran off the end
        const b = buf[i++]!;
        v |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7n;
      }
      return Number(v);
    }
    // Skip any field that is not the height we want, bailing on truncation.
    if (wire === 2) {
      let len = 0;
      let s = 0;
      for (;;) {
        if (i >= buf.length) return null;
        const b = buf[i++]!;
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      i += len;
    } else if (wire === 0) {
      for (;;) {
        if (i >= buf.length) return null;
        if (!(buf[i++]! & 0x80)) break;
      }
    } else {
      break; // wire types we do not expect; stop rather than misread
    }
  }
  return null;
}

/**
 * Primary source: the hosh network-health dashboard aggregates the tip across
 * every public testnet lightwalletd and publishes it as plain JSON. Taking the
 * max height over the ONLINE testnet servers is more robust than trusting one
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

/** Do the actual network work: hosh first, then a direct node. */
async function fetchNetworkTip(): Promise<number | null> {
  const h = await fromHosh(5000).catch(() => null);
  if (h != null && h > 0) return h;
  // hosh down or its testnet filter yielded nothing — degrade to a direct node,
  // and say so, because a silent degrade to a single source defeats the point of
  // the aggregate (App's medium on #171).
  console.warn("[externalTip] hosh gave no testnet height; falling back to direct GetLatestBlock");
  for (const endpoint of config.lightwalletdEndpoints) {
    try {
      const height = await getLatestBlock(new URL(endpoint).host, 5000);
      if (height != null && height > 0) return height;
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

const STALE_MS = 30_000; // refresh in the background once the cache is older than this
const MAX_AGE_MS = 5 * 60_000; // beyond this we no longer claim to know the tip

let cache: { height: number | null; at: number } = { height: null, at: 0 };
let refreshing = false;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const h = await fetchNetworkTip();
    if (h != null && h > 0) cache = { height: h, at: Date.now() };
    // On failure we keep the last-known cache rather than clearing it; MAX_AGE_MS
    // is what eventually turns a long outage into an honest "cannot verify".
  } finally {
    refreshing = false;
  }
}

/** Kick an initial fetch at boot so the first readiness check has a value. */
export function warmExternalTip(): Promise<void> {
  return refresh();
}

/**
 * The network tip according to sources that are NOT our own node. NON-BLOCKING:
 * returns the last-known cached value immediately and triggers a background
 * refresh if the cache is stale. Returns null when we have no fresh-enough value
 * — that is "cannot verify freshness", NOT "we are healthy": the caller must not
 * treat null as a pass (#75 not-seen vs cannot-say).
 */
export function getExternalTip(): number | null {
  const age = Date.now() - cache.at;
  if (age > STALE_MS) void refresh();
  if (cache.at === 0 || age > MAX_AGE_MS) return null;
  return cache.height;
}
