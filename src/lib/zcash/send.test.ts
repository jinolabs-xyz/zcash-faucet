import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "./address.ts";

// Runs the production ZalletSender against scripts/fake-zallet.mjs, so the
// balance and send behaviour is covered on the path that actually ships.
const RPC_PORT = 28451;
process.env.FAUCET_SENDER = "zallet";
process.env.ZALLET_RPC_URL = `http://127.0.0.1:${RPC_PORT}/`;
process.env.ZALLET_ACCOUNT = "test-account";
process.env.ZALLET_ADDRESS = "utest1testfaucet";
process.env.ZALLET_MIN_CONF = "0";
process.env.ZALLET_POLL_MS = "250";

const { getSender, safeBalance } = await import("./send.ts");

const TM: AddressInfo = { valid: true, kind: "transparent", shielded: false };
const req = (amountZat: bigint) => ({ toAddress: "tmTestRecipient", addressInfo: TM, amountZat });

let wallet: ChildProcess;
before(async () => {
  wallet = spawn("node", ["scripts/fake-zallet.mjs"], {
    env: { ...process.env, PORT: String(RPC_PORT), BALANCE_TAZ: "1" },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try {
      await getSender().balance();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("fake-zallet did not come up");
});
after(() => {
  try { process.kill(-wallet.pid!, "SIGKILL"); } catch { /* already gone */ }
});

test("the configured sender is the shielded one", () => {
  assert.equal(getSender().name, "zallet");
});

test("balance reads what the wallet reports", async () => {
  assert.equal(await getSender().balance(), 100_000_000n); // 1 TAZ
});

test("a send returns a txid and debits the wallet", async () => {
  const before = await getSender().balance();
  const result = await getSender().send(req(10_000_000n));
  // txid is optional on SendResult now, because Crosslink genuinely returns none. So
  // the TAZ path has to ASSERT it is present rather than lean on the type to promise it:
  // the widening moved that guarantee from the compiler to here, and this is where it
  // belongs, since "zallet returned a txid" is a claim about zallet, not about a type.
  assert.ok(result.txid, "the TAZ sender must return a txid");
  assert.match(result.txid, /^[0-9a-f]{64}$/);
  assert.ok(result.explorerUrl?.includes(result.txid));
  assert.equal(await getSender().balance(), before - 10_000_000n);
});

test("a send beyond the balance is refused and moves nothing", async () => {
  const before = await getSender().balance();
  await assert.rejects(() => getSender().send(req(before + 1n)), /insufficient/i);
  assert.equal(await getSender().balance(), before);
});

test("safeBalance mirrors the sender", async () => {
  assert.equal(await safeBalance(), await getSender().balance());
});
