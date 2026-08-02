/**
 * What the ledger records when a send finishes, and what it refuses to record.
 *
 * Crosslink's faucet primitive returns an amount and no transaction id, so a cTAZ claim
 * genuinely has nothing to put in that column. The tempting fix is the one that was
 * already here: `txid ?? ""`, which turns "there is none" into "there is an empty one"
 * at the write, exactly as `balance ?? 0` turned an unreadable wallet into a zero.
 *
 * So: NULL is stored as NULL, and a sent claim with no txid is refused unless the caller
 * states that the network has none. The refusal matters more than the storage, because
 * the day a Zallet bug drops a txid it has to land as a failure rather than be filed as
 * an expected absence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real sqlite ledger in a throwaway dir, driven through the production reserveClaim and
// finalizeClaim path, same setup as inflight.test.ts. My first attempt invented its own
// options shape and silenced the mismatch with `as never`, which turned a signature error
// into a runtime TypeError inside fingerprintAddress: the cast hid exactly what the type
// was there to tell me.
process.chdir(mkdtempSync(join(tmpdir(), "faucet-finalize-")));
process.env.DB_BACKEND = "sqlite";

const { reserveClaim, finalizeClaim } = await import("./index.ts");
const { default: Database } = await import("better-sqlite3");

let seq = 0;
const reserve = async (address: string) => {
  const r = await reserveClaim({
    address, ipHash: null, subnetHash: null, amountZat: 10_000_000n,
    now: 1_800_000_000 + seq++ * 200_000, cooldownSeconds: 86_400,
    dailyCapZat: 100_000_000_000n, subnetDailyMax: 1_000_000,
  });
  assert.equal(r.ok, true, `reservation failed for ${address}`);
  return (r as { claimId: number }).claimId;
};

// Read the column directly rather than through a helper, because the whole question is
// what is IN the cell: NULL and "" are different values and a convenience accessor is
// exactly the sort of thing that would flatten them on the way out.
const txidOf = (claimId: number): string | null => {
  const db = new Database("data/faucet.db", { readonly: true });
  const row = db.prepare("SELECT txid FROM claims WHERE id = ?").get(claimId) as { txid: string | null };
  db.close();
  return row.txid;
};

test("a TAZ claim records its txid", async () => {
  const id = await reserve("addr-taz");
  await finalizeClaim(id, "sent", "abc123");
  assert.equal(txidOf(id), "abc123");
});

test("A SENT CLAIM WITH NO TXID IS REFUSED, because that is a bug not an absence", async () => {
  const id = await reserve("addr-dropped");
  await assert.rejects(
    () => finalizeClaim(id, "sent", null),
    /must carry a txid/,
    "a Zallet bug dropping a txid has to land as a failure, not as an expected absence",
  );
  await assert.rejects(() => finalizeClaim(id, "sent", ""), /must carry a txid/);
});

test("a network that genuinely has none stores NULL, not an empty string", async () => {
  // The distinction the old `txid ?? ""` destroyed at the write.
  const id = await reserve("addr-ctaz");
  await finalizeClaim(id, "sent", null, "network-has-no-txid");
  assert.equal(txidOf(id), null, "an absent txid must be recorded as absent");
  assert.notEqual(txidOf(id), "", "an empty string is a value, and it is not this one");
});

test("a failed claim needs no txid and is not required to explain itself", async () => {
  // A send that failed has nothing to record and never did. The guard is about `sent`.
  const id = await reserve("addr-failed");
  await finalizeClaim(id, "failed", null);
  assert.equal(txidOf(id), null);
});

test("the exemption is a reason, so it cannot be passed by accident", async () => {
  // A boolean would be one stray `true` away from filing a real Zallet bug as expected.
  // A spelled-out reason reads at the call site as the claim it is making, and tsc
  // rejects anything else, so this test only has to pin that the accepted spelling works.
  const id = await reserve("addr-reason");
  await finalizeClaim(id, "sent", null, "network-has-no-txid");
  assert.equal(txidOf(id), null);
});

test("an empty txid on a path that allows none is folded to NULL, deliberately", () => {
  // `||` rather than `??` at the write, so "" becomes NULL. An empty transaction id is
  // never valid, so recording it as the absence it is beats preserving a value someone
  // later has to decide about. The CTO spotted the coercion; this pins it as a choice.
  // The `sent` guard refuses "" outright, so this exercises the failed path.
  return (async () => {
    const id = await reserve("addr-empty");
    await finalizeClaim(id, "failed", "");
    assert.equal(txidOf(id), null, "an empty txid should not survive as an empty string");
  })();
});
