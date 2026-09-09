/**
 * How a configured lightwalletd endpoint URL becomes a gRPC target and credentials.
 *
 * ONE PLACE, because it had drifted: grpc.ts and expiryTip.ts honoured the scheme and
 * port, externalTip.ts always dialled TLS on `new URL(endpoint).host`, so the
 * self-hosted `http://zaino:8137` the z3 docs give operators worked for balances and
 * silently failed for the tip oracle ("wrong version number"), leaving the money gate
 * hosh-only (review of register #6, round 6). The port rule, unchanged from grpc.ts: an
 * explicit port wins and is TLS only when it is 443 or the scheme is https; no port at
 * all means 443 with TLS whatever the scheme, so `http://zaino:8137` is plain gRPC and
 * `http://host` is not the way to ask for plaintext on 443 (nobody serves that).
 */
import * as grpc from "@grpc/grpc-js";

export interface GrpcTarget {
  /** host:port, always with the port, since grpc-js would otherwise pick 443. */
  target: string;
  tls: boolean;
  creds: grpc.ChannelCredentials;
}

export function targetFor(endpoint: string): GrpcTarget {
  const url = new URL(endpoint);
  const tls = url.protocol === "https:" || url.port === "443" || url.port === "";
  const port = url.port || (tls ? "443" : "9067");
  return {
    target: `${url.hostname}:${port}`,
    tls,
    creds: tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
  };
}
