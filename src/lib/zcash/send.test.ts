import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "./address.ts";

// config reads env once at module load, so pin the profile before the dynamic
// import. Each test file is its own process under node --test, which is what
// makes per-file profiles work.
process.env.FAUCET_SENDER = "mock";
process.env.FAUCET_MOCK_BALANCE_TAZ = "1";

const { getSender, safeBalance, creditMockBalance } = await import("./send.ts");

const TM_INFO: AddressInfo = { valid: true, kind: "transparent", shielded: false };
const req = (amountZat: bigint) => ({ toAddress: "tmTestRecipientAddressXXXXXXXXXXXXX", addressInfo: TM_INFO, amountZat });

test("mock sender starts at the configured simulated balance", async () => {
  assert.equal(getSender().name, "mock");
  assert.equal(await getSender().balance(), 100_000_000n); // 1 TAZ
});

test("a send returns a txid shape and decrements the balance", async () => {
  const before = await getSender().balance();
  const result = await getSender().send(req(10_000_000n)); // 0.1 TAZ
  assert.match(result.txid, /^[0-9a-f]{64}$/);
  assert.ok(result.explorerUrl?.includes(result.txid));
  assert.equal(await getSender().balance(), before - 10_000_000n);
});

test("a send beyond the balance throws and moves nothing", async () => {
  const before = await getSender().balance();
  await assert.rejects(() => getSender().send(req(before + 1n)), /insufficient/i);
  assert.equal(await getSender().balance(), before);
});

test("safeBalance mirrors the sender balance in mock mode", async () => {
  assert.equal(await safeBalance(), await getSender().balance());
});

test("creditMockBalance adds funds in mock mode", async () => {
  const before = await getSender().balance();
  creditMockBalance(50_000_000n);
  assert.equal(await getSender().balance(), before + 50_000_000n);
});
