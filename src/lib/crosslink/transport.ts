/**
 * How the faucet reaches the Crosslink node (#409).
 *
 * THE CONTAINER HAS NO ROUTE TO THAT RPC AND THAT IS DELIBERATE. The node binds loopback
 * only because it holds funds. Measured from inside zcash-faucet-faucet-1: the
 * container's own loopback is not the host's, 172.17.0.1 times out, and
 * host.docker.internal is not defined in this compose setup.
 *
 * `ctaz-status.sh` solved READING with a file. Paying cannot use a file - it needs a
 * request and a reply - so it gets a unix socket in the volume the container already
 * mounts, with a host-side broker (`ctaz-rpc-broker.sh`) that allowlists 5 methods and
 * forwards them to the node. No new host, no new port, nothing listening on a network
 * interface, and nothing new to pay for.
 *
 * WHY NOT fetch(). Node's fetch has no unix socket support at all. `http.request` does,
 * via socketPath, but the broker does not speak HTTP either: it reads one JSON object and
 * writes one back. So this is a plain socket write and read, which is also the smallest
 * thing that can go wrong on a money path.
 *
 * The TCP path is kept for local development, where the node IS reachable. Both return
 * the same shape so callers never branch on which one ran.
 */
import { connect } from "node:net";

export interface RpcResult {
  /** Parsed JSON-RPC reply, or null when we could not get one. */
  reply: { result?: unknown; error?: { code?: number; message?: string } } | null;
  /** Which transport answered. Null when neither was configured or neither worked. */
  via: "socket" | "http" | null;
  /** Present when reply is null, for the log line. Never shown to a claimant. */
  failure?: string;
}

/**
 * One request, one reply, then the connection closes.
 *
 * The write side is half-closed after sending, which is what tells the broker the
 * request is complete. Without it the broker's `read()` waits for more bytes that never
 * come, and the call hangs until a timeout on both ends - the failure looks like a slow
 * node rather than a protocol mistake, which is the expensive kind of wrong.
 */
export function rpcOverSocket(
  socketPath: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<RpcResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: RpcResult) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // Already gone. Nothing to report: the answer, or the failure, is decided.
      }
      resolve(r);
    };

    const chunks: Buffer[] = [];
    const sock = connect(socketPath);
    sock.setTimeout(timeoutMs);

    sock.on("connect", () => {
      sock.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });
    sock.on("data", (d: Buffer) => chunks.push(d));
    sock.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return done({ reply: null, via: null, failure: "the broker closed without answering" });
      try {
        done({ reply: JSON.parse(raw), via: "socket" });
      } catch {
        // Deliberately not logging `raw`: on a money path the reply can carry an address.
        done({ reply: null, via: null, failure: "the broker's answer was not JSON" });
      }
    });
    // A timeout is NOT an answer. Resolving with a null reply here rather than throwing
    // keeps every failure on one path, and the gate above treats a null as cannot-verify,
    // which refuses. The alternative - an exception some caller forgets to catch - is how
    // a send path ends up reporting success it never had.
    sock.on("timeout", () => done({ reply: null, via: null, failure: `no reply within ${timeoutMs}ms` }));
    sock.on("error", (e: Error) => done({ reply: null, via: null, failure: e.message }));
  });
}

/** The development path: the node reachable directly over TCP. */
export async function rpcOverHttp(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<RpcResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { reply: null, via: null, failure: `HTTP ${res.status}` };
    return { reply: (await res.json()) as RpcResult["reply"], via: "http" };
  } catch (e) {
    return { reply: null, via: null, failure: e instanceof Error ? e.message : "fetch failed" };
  }
}

/**
 * SOCKET FIRST, and in production it is the only one configured.
 *
 * The order matters on a developer's machine, where both may be set: the socket is what
 * production uses, so it is what should be exercised. Falling back to HTTP when the
 * socket is configured but broken would hide exactly the failure worth finding, so a
 * configured socket that does not answer is the answer.
 */
export async function ctazRpc(
  cfg: { socketPath: string; rpcUrl: string; timeoutMs: number },
  method: string,
  params: unknown[] = [],
): Promise<RpcResult> {
  if (cfg.socketPath) return rpcOverSocket(cfg.socketPath, method, params, cfg.timeoutMs);
  if (cfg.rpcUrl) return rpcOverHttp(cfg.rpcUrl, method, params, cfg.timeoutMs);
  return { reply: null, via: null, failure: "no crosslink transport configured" };
}
