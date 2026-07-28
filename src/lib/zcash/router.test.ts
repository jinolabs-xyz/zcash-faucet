import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "./address.ts";

// Real mode routes by recipient kind, and getting that wrong either strands
// funds or refuses a payable address. These assert the routing decision only:
// no node is reachable, so anything that gets past the router fails on the
// network, which is itself proof it was routed rather than refused.
process.env.FAUCET_SENDER = "real";
process.env.FAUCET_WALLET_SEED = "0".repeat(63) + "1";
process.env.LIGHTWALLETD_ENDPOINT = "http://127.0.0.1:59997";

const { getSender } = await import("./send.ts");

const info = (kind: AddressInfo["kind"], shielded: boolean): AddressInfo => ({ valid: true, kind, shielded });
const send = (toAddress: string, addressInfo: AddressInfo) =>
  getSender().send({ toAddress, addressInfo, amountZat: 10_000_000n });

test("real mode composes rather than exploding on load", () => {
  // Regression guard: the backends load through createRequire, and a bare
  // require() here used to be a ReferenceError outside the bundler.
  assert.equal(getSender().name, "real");
});

test("a Sapling-only recipient is refused with a reason, not silently mispaid", async () => {
  // t2z emits Orchard outputs only, so there is no path to a Sapling-only
  // address. Refusing is correct; quietly routing it somewhere else would not be.
  const err = await send("ztestsapling1recipient", info("sapling", true)).then(() => null, (e: Error) => e);
  assert.ok(err, "sapling-only must be refused");
  assert.match(err.message, /sapling/i);
  assert.match(err.message, /utest1|unified|transparent/i, "should point at what to use instead");
});

test("a transparent recipient routes to the transparent sender", async () => {
  // Reaches the network and fails there, which is how we know it was routed
  // and not refused by a guard.
  const err = await send("tmRecipientAddress", info("transparent", false)).then(() => null, (e: Error) => e);
  assert.ok(err, "expected a network failure, not a clean result");
  assert.doesNotMatch(err.message, /sapling|shielded/i, "a tm address must not hit a shielded guard");
});

test("a unified recipient routes to t2z, not to the transparent sender", async () => {
  const err = await send("utest1recipient", info("unified", true)).then(() => null, (e: Error) => e);
  assert.ok(err, "expected a network failure, not a clean result");
  // The transparent sender refuses shielded recipients outright. Seeing that
  // message here would mean a unified address was misrouted to it.
  assert.doesNotMatch(err.message, /stranded/i, "unified was misrouted to the transparent sender");
});
