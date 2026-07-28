import { test } from "node:test";
import assert from "node:assert/strict";
import { explorerTxUrl } from "./explorer.ts";

const TXID = "a".repeat(64);

test("builds a testnet explorer link for a txid", () => {
  assert.equal(explorerTxUrl(TXID), `https://blockexplorer.one/zcash/testnet/tx/${TXID}`);
});

test("no txid means no link, never a link to nowhere", () => {
  assert.equal(explorerTxUrl(""), undefined);
});

test("a deploy can point somewhere else without a code change", () => {
  process.env.FAUCET_EXPLORER_TX_URL = "https://example.test/tx/{txid}?net=testnet";
  try {
    assert.equal(explorerTxUrl(TXID), `https://example.test/tx/${TXID}?net=testnet`);
  } finally {
    delete process.env.FAUCET_EXPLORER_TX_URL;
  }
});

test("txids are url-encoded, a junk value cannot break out of the path", () => {
  assert.equal(explorerTxUrl("../../evil?x=1"), "https://blockexplorer.one/zcash/testnet/tx/..%2F..%2Fevil%3Fx%3D1");
});
