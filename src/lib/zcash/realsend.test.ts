import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "./address.ts";
import type { Utxo } from "./grpc.ts";

process.env.FAUCET_SENDER = "real";
// A throwaway testnet WIF so faucetWallet() can derive without touching a node.
process.env.FAUCET_WALLET_SEED = "0".repeat(63) + "1";

const { selectInputs, FEE_ZAT, RealSender } = await import("./realsend.ts");

const utxo = (valueZat: bigint, txid = "a".repeat(64), index = 0): Utxo => ({
  txid,
  txidBytes: Buffer.from(txid, "hex"),
  index,
  script: "76a914",
  scriptBytes: Buffer.from("76a914", "hex"),
  valueZat,
  height: 100,
});

/* ── coin selection ─────────────────────────────────────────────────────
 * The money-shaped part of this file: pick enough inputs, and stop. Under-
 * selecting strands the send, over-selecting needlessly churns the wallet's
 * UTXO set and leaks more of the faucet's history on a transparent chain.
 */

test("stops as soon as the target is covered", () => {
  const { chosen, total } = selectInputs([utxo(100n), utxo(100n), utxo(100n)], 150n);
  assert.equal(chosen.length, 2, "should not take a third input it does not need");
  assert.equal(total, 200n);
});

test("one input that covers it on its own is enough", () => {
  const { chosen, total } = selectInputs([utxo(500n), utxo(500n)], 500n);
  assert.equal(chosen.length, 1);
  assert.equal(total, 500n);
});

test("exact-fit takes exactly what it needs", () => {
  const { chosen, total } = selectInputs([utxo(60n), utxo(40n), utxo(999n)], 100n);
  assert.equal(chosen.length, 2);
  assert.equal(total, 100n);
});

test("insufficient funds report the shortfall rather than pretending", () => {
  // Caller compares total against need, so the honest answer here is
  // everything it had plus a total below the target.
  const { chosen, total } = selectInputs([utxo(10n), utxo(20n)], 100n);
  assert.equal(chosen.length, 2, "should have tried every input");
  assert.equal(total, 30n);
  assert.ok(total < 100n);
});

test("no utxos is empty, not a throw", () => {
  const { chosen, total } = selectInputs([], 100n);
  assert.deepEqual(chosen, []);
  assert.equal(total, 0n);
});

test("selection must cover the fee too, not just the drip", () => {
  // A wallet holding exactly the drip cannot pay: the fee is the difference
  // between a send that broadcasts and one rejected for a bad balance.
  const drip = 10_000_000n;
  const { total } = selectInputs([utxo(drip)], drip + FEE_ZAT);
  assert.ok(total < drip + FEE_ZAT, "exactly-the-drip must not look sufficient");
});

/* ── the guard that protects the faucet from stranding its own funds ──── */

const shielded: AddressInfo = { valid: true, kind: "unified", shielded: true };

test("the transparent sender refuses a shielded recipient before any network call", async () => {
  // RealSender builds a transparent tx whose change returns to a t-address. A
  // shielded recipient would send change into a pool it cannot re-spend, so
  // this must refuse, and refuse early: no node, no wallet, no funds moved.
  const err = await new RealSender()
    .send({ toAddress: "utest1recipient", addressInfo: shielded, amountZat: 1n })
    .then(() => null, (e: Error) => e);

  assert.ok(err, "a shielded recipient must be refused");
  assert.match(err.message, /shielded/i);
  assert.match(err.message, /stranded|transparent/i, "the reason should say why, not just no");
});
