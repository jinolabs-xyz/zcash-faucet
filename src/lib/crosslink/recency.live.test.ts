/**
 * The gate read against the DOUBLE, over real HTTP, rather than against a literal.
 *
 * The unit tests feed `readingFor` objects I typed by hand, so they prove the rules and
 * nothing about whether those rules fit what a node actually sends. This drives
 * scripts/fake-crosslink.mjs, whose shapes come from the spike, so the two halves have to
 * agree or this fails. A double nothing reads is a fiction with no consequences.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readingFor, canServeCtaz } from "./recency.ts";

const PORT = 28497;
let node: ChildProcess;

const rpc = async (method: string, params: unknown[] = []) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json() as Promise<{ result?: unknown; error?: { message: string } }>;
};

const up = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await rpc("is_tfl_activated");
      return true;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
};

before(async () => {
  node = spawn("node", ["scripts/fake-crosslink.mjs"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  assert.ok(await up(), "the crosslink double never came up");
});

after(() => { node?.kill(); });

test("the gate reads the double's reply as ready, so the shapes agree", async () => {
  const { result } = await rpc("get_tfl_recency_status");
  const r = readingFor(result, Date.now());
  assert.equal(r.state, "ready", `the double's own reply did not classify: ${JSON.stringify(result)}`);
  assert.equal(canServeCtaz(r.state), true);
  assert.ok(r.height && r.height > 0, "height should come through as a real number");
  assert.equal(r.finalizers, 2);
});

test("THE PARAMETER SHAPE: a bare string is refused, a struct is accepted", async () => {
  // The mistake that cost the spike two calls, and the one property that makes this
  // double able to fail us. If it accepted a bare string we could ship the wrong shape
  // and pass everything.
  const bare = await rpc("requestfaucetdonation", ["utest1abcdefghij"]);
  assert.equal(bare.error?.message, "Invalid params", "a bare string must be refused");

  const struct = await rpc("requestfaucetdonation", [{ address: "utest1abcdefghij" }]);
  assert.equal(struct.error, undefined, `the struct form should be accepted: ${JSON.stringify(struct)}`);
});

test("their reply carries an amount and NO transaction id", async () => {
  // The whole reason SendResult had to widen. Asserted here so that if their surface ever
  // grows a txid, this fails and we find out rather than continuing to say there is none.
  const { result } = await rpc("requestfaucetdonation", [{ address: "utest1nodoubleofmine" }]);
  const r = result as Record<string, unknown>;
  assert.equal(r.amount, 50_000_000, "their fixed FAUCET_VALUE");
  for (const k of ["txid", "hash", "txhash", "id"]) {
    assert.equal(r[k], undefined, `their reply unexpectedly carries a ${k}`);
  }
});

test("there is no balance method to call, which is why the panel says unknown", async () => {
  // Pinning an ABSENCE. The CTO grepped all 50 methods in their zebra-rpc and found only
  // the transparent address index, which cannot see an Orchard wallet. If a balance
  // method ever appears in the double, someone invented it.
  for (const m of ["getbalance", "z_getbalance", "getwalletinfo", "get_wallet_balance"]) {
    const { error } = await rpc(m);
    assert.match(error?.message ?? "", /Method not found/, `${m} should not exist`);
  }
});

test("a node with TFL off is not-activated, not ready", async () => {
  const off = spawn("node", ["scripts/fake-crosslink.mjs"], {
    env: { ...process.env, PORT: String(PORT + 1), TFL_ACTIVATED: "false" },
    stdio: "ignore",
  });
  try {
    let res: { error?: { message: string } } | null = null;
    for (let i = 0; i < 60; i++) {
      try {
        res = await (await fetch(`http://127.0.0.1:${PORT + 1}/`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_tfl_recency_status", params: [] }),
        })).json();
        break;
      } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.match(res?.error?.message ?? "", /not activated/i);
    // An error reply is not a reading, so the gate refuses rather than guessing.
    assert.equal(canServeCtaz(readingFor(null, Date.now()).state), false);
  } finally { off.kill(); }
});
