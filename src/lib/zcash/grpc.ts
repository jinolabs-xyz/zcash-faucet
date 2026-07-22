/**
 * lightwalletd / Zaino gRPC client (CompactTxStreamer).
 * Used for read-only chain queries: latest block, node info, and — crucially —
 * TRANSPARENT address balances (shielded balances are private and not queryable
 * by address). Tries each configured endpoint in order (failover).
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { config } from "../config";

// Load the trimmed proto once from the repo (readable at runtime under Node).
const pkgDef = protoLoader.loadSync(path.join(process.cwd(), "proto", "service.proto"), {
  keepCase: true,
  longs: String,
  defaults: true,
  oneofs: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = grpc.loadPackageDefinition(pkgDef) as any;
const CompactTxStreamer = proto.cash.z.wallet.sdk.rpc.CompactTxStreamer;

function targetFor(endpoint: string): { target: string; creds: grpc.ChannelCredentials } {
  const url = new URL(endpoint);
  const tls = url.protocol === "https:" || url.port === "443" || url.port === "";
  const port = url.port || (tls ? "443" : "9067");
  return {
    target: `${url.hostname}:${port}`,
    creds: tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
  };
}

function deadline(ms: number): Date {
  return new Date(Date.now() + ms);
}

/** Run a unary RPC against the first endpoint that answers. */
async function callFirst<T>(
  method: string,
  request: unknown,
  timeoutMs = 6000,
): Promise<{ result: T; endpoint: string }> {
  let lastErr: unknown;
  for (const endpoint of config.lightwalletdEndpoints) {
    const { target, creds } = targetFor(endpoint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = new CompactTxStreamer(target, creds);
    try {
      const result = await new Promise<T>((resolve, reject) => {
        client[method](
          request,
          { deadline: deadline(timeoutMs) },
          (err: grpc.ServiceError | null, res: T) => (err ? reject(err) : resolve(res)),
        );
      });
      return { result, endpoint };
    } catch (err) {
      lastErr = err;
    } finally {
      client.close?.();
    }
  }
  throw lastErr ?? new Error("All lightwalletd endpoints failed.");
}

export interface LightdInfo {
  version: string;
  vendor: string;
  chainName: string;
  blockHeight: string;
  estimatedHeight: string;
  consensusBranchId: string;
  saplingActivationHeight: string;
}

export async function getLightdInfo(): Promise<{ info: LightdInfo; endpoint: string }> {
  const { result, endpoint } = await callFirst<LightdInfo>("GetLightdInfo", {});
  return { info: result, endpoint };
}

export async function getLatestBlock(): Promise<{ height: string; endpoint: string }> {
  const { result, endpoint } = await callFirst<{ height: string }>("GetLatestBlock", {});
  return { height: result.height, endpoint };
}

/** Confirmed balance (zatoshi) for one or more TRANSPARENT addresses. */
export async function getTaddressBalance(addresses: string[]): Promise<bigint> {
  const { result } = await callFirst<{ valueZat: string }>("GetTaddressBalance", { addresses });
  return BigInt(result.valueZat ?? "0");
}
