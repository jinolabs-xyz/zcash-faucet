import { test } from "node:test";
import assert from "node:assert/strict";
import { targetFor } from "./grpcTarget.ts";

test("https with the default port is TLS on 443, and the port is spelled out for grpc-js", () => {
  const t = targetFor("https://testnet.zec.rocks");
  assert.equal(t.target, "testnet.zec.rocks:443");
  assert.equal(t.tls, true);
});

test("an explicit port is kept, on either scheme", () => {
  assert.equal(targetFor("https://lightwalletd.testnet.electriccoin.co:9067").target, "lightwalletd.testnet.electriccoin.co:9067");
  assert.equal(targetFor("https://lightwalletd.testnet.electriccoin.co:9067").tls, true);
  const zaino = targetFor("http://zaino:8137");
  assert.equal(zaino.target, "zaino:8137");
  assert.equal(zaino.tls, false, "the self-hosted Zaino in the z3 docs speaks plain gRPC");
});

test("no port at all is 443 with TLS whatever the scheme, the rule grpc.ts always had", () => {
  const t = targetFor("http://lightwalletd.local");
  assert.equal(t.target, "lightwalletd.local:443");
  assert.equal(t.tls, true);
});

test("an explicit non-443 port on http is plaintext; 443 on http is still TLS", () => {
  assert.equal(targetFor("http://h:9067").tls, false);
  assert.equal(targetFor("http://h:9067").target, "h:9067");
  assert.equal(targetFor("http://h:443").tls, true);
});
