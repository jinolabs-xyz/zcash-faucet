import { test } from "node:test";
import assert from "node:assert/strict";

// Each case needs a fresh config module, since it reads env once at load.
let n = 0;
async function loadWith(sender?: string) {
  if (sender === undefined) delete process.env.FAUCET_SENDER;
  else process.env.FAUCET_SENDER = sender;
  return import(`./config.ts?sender=${n++}`);
}

test("a stale FAUCET_SENDER=mock refuses to boot", async () => {
  // It used to fall through to the REAL transparent sender, so a leftover
  // value in a box env would have routed drips at the hot wallet.
  await assert.rejects(() => loadWith("mock"), /FAUCET_SENDER must be one of/);
});

test("the refusal tells a mock user where to go", async () => {
  const err = await loadWith("mock").then(() => null, (e: Error) => e);
  assert.match(err!.message, /fake-zallet|zallet/);
});

test("a typo refuses rather than picking a sender", async () => {
  await assert.rejects(() => loadWith("zalet"), /got "zalet"/);
  await assert.rejects(() => loadWith("REAL"), /got "REAL"/);
  await assert.rejects(() => loadWith(""), /FAUCET_SENDER must be one of/);
});

test("both real values are accepted", async () => {
  assert.equal((await loadWith("zallet")).config.sender, "zallet");
  assert.equal((await loadWith("real")).config.sender, "real");
});

test("unset defaults to the shielded sender", async () => {
  assert.equal((await loadWith(undefined)).config.sender, "zallet");
});
