/**
 * A view of the network tip from public light-wallet infrastructure we do NOT run.
 *
 * INDEPENDENT OF OUR NODE, WHICH IS NOT THE SAME AS INDEPENDENT (#227). Measured
 * 2026-07-30 by pulling hosh's raw JSON: it lists exactly TWO testnet servers,
 * `testnet.zec.rocks` and `zaino.testnet.unsafe.zec.rocks`, both zec.rocks, and the
 * ECC endpoint that used to be listed has dropped off. `LIGHTWALLETD_ENDPOINT`
 * defaults to the first of those two, so the fallback path below reads a host that
 * hosh already aggregates.
 *
 * That is still worth having, because zebra is not a lightwalletd and zec.rocks
 * genuinely did not get its tip from us, so this catches the failure it was built
 * for: our node silently stopping while the network moves on. What it cannot do is
 * survive zec.rocks being wrong or dark, because there is no second opinion to fall
 * back to. Do not read "independent" here as "corroborated by more than one org". This is the antidote to the failure that killed Fauzec's faucet
 * (#170): a node that has silently stopped following the chain keeps reporting
 * its own frozen tip as the tip, so any readiness check that trusts our own node
 * is fooled. Comparing our node's tip against a DIFFERENT view is the only way to
 * notice we have diverged from reality. We depend on nobody for money - this is
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
 * anything malformed or truncated - never a fabricated number, so a partial read
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
 * node - a single lagging server cannot make us think we are behind, and the
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

/** Do the actual network work: hosh first, then a direct node. Carries provenance. */
async function fetchNetworkTip(): Promise<{ height: number | null; source: TipSource; host: string | null }> {
  const h = await fromHosh(5000).catch(() => null);
  if (h != null && h > 0) return { height: h, source: "hosh", host: null };
  // hosh down or its testnet filter yielded nothing - degrade to a direct node,
  // and say so, because a silent degrade to a single source defeats the point of
  // the aggregate (App's medium on #171).
  console.warn("[externalTip] hosh gave no testnet height; falling back to direct GetLatestBlock");
  for (const endpoint of config.lightwalletdEndpoints) {
    try {
      const host = new URL(endpoint).host;
      const height = await getLatestBlock(host, 5000);
      if (height != null && height > 0) return { height, source: "direct", host };
    } catch {
      // try the next endpoint
    }
  }
  return { height: null, source: "none", host: null };
}

const STALE_MS = 30_000; // refresh in the background once the cache is older than this
const MAX_AGE_MS = 5 * 60_000;
/** Exported for tests only: the age rule above is pure but the bound is private. */
export const MAX_AGE_MS_FOR_TESTS = MAX_AGE_MS; // beyond this we no longer claim to know the tip

/**
 * Where a cached tip came from (#227). A DIAGNOSTIC, deliberately not a permission.
 *
 * The obvious use, letting a money path require the aggregate, is the one it must
 * NOT be put to. The shield gate compares our zebra against this number, and a
 * direct endpoint read is exactly as independent of zebra as the aggregate is, so
 * requiring `hosh` would refuse shields whenever hosh is down for no correctness
 * gain. That is an availability regression on the money path, which is the #171
 * mistake wearing different clothes.
 *
 * And per the header, both labels currently denote zec.rocks, so a caller
 * distinguishing them would be reading a true field that answers nothing about
 * independence. What it IS good for: telling an operator which host answered, and
 * letting a future cross-check exclude the specific host it is checking, which is
 * the gap that made the #190 cross-check unbuildable.
 */
export type TipSource = "hosh" | "direct" | "none";

export interface TipReading {
  height: number | null;
  source: TipSource;
  /** The host that answered, when we know it. Null for the aggregate. */
  host: string | null;
}

let cache: { height: number | null; at: number; source: TipSource; host: string | null } = {
  height: null,
  at: 0,
  source: "none",
  host: null,
};
let refreshing = false;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const r = await fetchNetworkTip();
    const h = r.height;
    if (h != null && h > 0) cache = { height: h, at: Date.now(), source: r.source, host: r.host };
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
 * - that is "cannot verify freshness", NOT "we are healthy": the caller must not
 * treat null as a pass (#75 not-seen vs cannot-say).
 */
export function getExternalTip(): number | null {
  return getExternalTipReading().height;
}

/**
 * The same value with its provenance (#227). Same non-blocking contract as
 * getExternalTip: last-known, a background refresh when stale, and a null height
 * meaning "cannot verify" rather than "healthy".
 *
 * When the height is null the source is "none", so a caller cannot accidentally
 * read a stale label beside an absent number and conclude something was checked.
 */
export function getExternalTipReading(): TipReading {
  const age = Date.now() - cache.at;
  if (age > STALE_MS) void refresh();
  return readingFor(cache, Date.now());
}

/**
 * The age rule, pure, so the states worth testing are reachable without a network.
 *
 * Extracted after my first attempt at testing this was vacuous: the only state a
 * unit test could reach was a cold cache, where "source is none" and "the two
 * accessors agree" hold trivially, so BOTH sabotages passed. Same shape as
 * chainFreshness and the ledger probe's verdictFor, and the same reason.
 *
 * The property with teeth is that a null height NEVER carries a source label. A
 * caller seeing `source: "hosh"` beside `height: null` would conclude something was
 * checked when nothing was, which is the failure this whole module exists to avoid.
 */
export function readingFor(
  c: { height: number | null; at: number; source: TipSource; host: string | null },
  now: number,
): TipReading {
  const age = now - c.at;
  if (c.at === 0 || age > MAX_AGE_MS || c.height == null) {
    return { height: null, source: "none", host: null };
  }
  return { height: c.height, source: c.source, host: c.host };
}
