/**
 * Endpoint management for the public lightwalletd / Zaino testnet backend.
 *
 * The Zcash Light Client Protocol is gRPC (service `cash.z.wallet.sdk.rpc.CompactTxStreamer`).
 * The heavy lifting — block scanning, note selection, witness building, and
 * zk-proof generation for a shielded spend — is done inside the wallet library
 * (see ./send.ts). This module holds the ordered endpoint list, a lightweight
 * reachability probe, and failover so a single dead endpoint doesn't sink the
 * faucet.
 */
import { config } from "../config";

export interface BackendStatus {
  endpoint: string; // the one we'd use (first reachable, else primary)
  network: "testnet";
  reachable: boolean;
  detail?: string;
  tried: { endpoint: string; reachable: boolean; detail?: string }[];
}

/**
 * Probe one endpoint. lightwalletd speaks gRPC (HTTP/2), so a plain fetch won't
 * complete an RPC — but a TCP/TLS-level response proves the host is up. Real
 * block-height reads happen through the wallet lib in ./send.ts.
 */
async function probe(endpoint: string): Promise<{ endpoint: string; reachable: boolean; detail?: string }> {
  try {
    const url = new URL(endpoint);
    const res = await fetch(`${url.protocol}//${url.host}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(4000),
    });
    return { endpoint, reachable: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { endpoint, reachable: false, detail: err instanceof Error ? err.message : "unreachable" };
  }
}

/** Probe all configured endpoints; report the first reachable one for the UI. */
export async function pingBackend(): Promise<BackendStatus> {
  const tried = await Promise.all(config.lightwalletdEndpoints.map(probe));
  const firstUp = tried.find((t) => t.reachable);
  return {
    endpoint: firstUp?.endpoint ?? config.lightwalletdEndpoint,
    network: "testnet",
    reachable: Boolean(firstUp),
    detail: firstUp?.detail ?? tried[0]?.detail,
    tried,
  };
}

/**
 * Resolve the endpoint the real sender should connect to: the first reachable
 * one in priority order. Returns null if every endpoint is down.
 */
export async function resolveEndpoint(): Promise<string | null> {
  for (const endpoint of config.lightwalletdEndpoints) {
    const { reachable } = await probe(endpoint);
    if (reachable) return endpoint;
  }
  return null;
}
