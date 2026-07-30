/**
 * Donation attribution (#192).
 *
 * Every test here is about a way our OWN money could be published as a donation,
 * because that is the only failure mode with a cost. Undercounting shows a smaller
 * number than the truth on a page nobody makes a decision from. Overcounting tells
 * the community that strangers funded a faucet we funded ourselves, on a repo where
 * the honesty of the numbers is most of the product.
 *
 * The fixtures are shaped from zallet 0.1.0-beta.1's own WalletTx/WalletTxOutput
 * serialization (snake_case, u64 value, from_account as a UUID string). The live
 * wallet is behind a tunnel I cannot reach from here, so the SHAPE is verified
 * against the source and the live RESPONSE is not verified at all. Anything that
 * depends on my reading of that source is called out in the test that assumes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RATE_LIMIT_SALT = "donations-test-salt";
const { tallyDonations, DONATION_POOLS } = await import("./donations.ts");

const TAZ = 100_000_000;
const OURS = "00000000-0000-4000-8000-000000000000"; // shape of a zallet account uuid

/** A confirmed donation: someone else's transaction, paying our shielded receiver. */
function donation(taz: number, height = 4_222_300) {
  return {
    txid: `donor-${height}-${taz}`,
    mined_height: height,
    expired_unmined: false,
    sent_note_count: 0, // we signed nothing
    outputs: [{ pool: "ironwood", from_account: null, value: taz * TAZ, is_change: false }],
  };
}

test("the 2026-07-29 shield sweep is NOT a donation, which is the whole point", () => {
  // The transaction that actually happened: 257 TAZ of our own mined coinbase moved
  // into our own shielded pool. It arrives at the donation address, it is confirmed,
  // and it is the largest receipt in the account's history. A counter that sums
  // received value publishes it as a gift.
  const sweep = {
    txid: "0ce563c5",
    mined_height: 4_222_201,
    expired_unmined: false,
    sent_note_count: 1, // we spent the coinbase note, so we built this
    outputs: [{ pool: "ironwood", from_account: OURS, value: 25_719_875_000, is_change: false }],
  };
  const t = tallyDonations([sweep]);
  assert.equal(t.zat, 0n, "our own sweep was counted as a donation");
  assert.equal(t.count, 0);
});

test("either signal alone is enough, because one of them can be missing", () => {
  // from_account is populated by the wallet from its own view of the inputs. If it
  // ever comes back null on a transaction we built (a partially-known input, a
  // recovered account, a zallet bug), the per-transaction sent_note_count still
  // catches it. Belt and braces on the only assertion that can overcount.
  const noFromAccount = {
    mined_height: 4_222_201,
    sent_note_count: 1,
    outputs: [{ pool: "ironwood", from_account: null, value: 50 * TAZ, is_change: false }],
  };
  assert.equal(tallyDonations([noFromAccount]).zat, 0n, "sent_note_count did not catch it");

  const noSentCount = {
    mined_height: 4_222_201,
    outputs: [{ pool: "ironwood", from_account: OURS, value: 50 * TAZ, is_change: false }],
  };
  assert.equal(tallyDonations([noSentCount]).zat, 0n, "from_account did not catch it");
});

test("mining income is excluded by the POOL, not by matching the mining address", () => {
  // Coinbase pays a transparent receiver of this same account, so it lands here with
  // from_account null and is_change false, looking exactly like a transparent
  // donation. We could exclude it by comparing to FAUCET_MINING_ADDRESS, but then an
  // unset or stale env var publishes block rewards as generosity. Excluding the
  // whole transparent pool cannot go stale.
  const coinbase = {
    mined_height: 4_222_150,
    sent_note_count: 0, // nobody spent anything, it is newly minted
    outputs: [
      { pool: "transparent", from_account: null, to_address: "tmG3VQxx", value: 625_000_000, is_change: false },
    ],
  };
  const t = tallyDonations([coinbase]);
  assert.equal(t.zat, 0n, "block reward published as a donation");
  assert.equal(t.count, 0);
  // Not silently dropped: an operator can still see value arrived.
  assert.equal(t.unattributedZat, 625_000_000n);
  assert.equal(t.unattributedCount, 1);
});

test("change coming back from a drip is not a donation", () => {
  const drip = {
    mined_height: 4_222_250,
    sent_note_count: 1,
    outputs: [
      { pool: "ironwood", from_account: OURS, value: 9 * TAZ, is_change: true },
      { pool: "ironwood", from_account: OURS, value: 1 * TAZ, is_change: false }, // the drip itself
    ],
  };
  assert.equal(tallyDonations([drip]).zat, 0n);
});

test("a real donation is counted, or none of the above means anything", () => {
  // The control. Every test above asserts a zero, so without this one they would all
  // pass against a function that returns zero unconditionally.
  const t = tallyDonations([donation(5), donation(0.25, 4_222_310)]);
  assert.equal(t.count, 2);
  assert.equal(t.zat, BigInt(5.25 * TAZ));
  assert.equal(t.lastHeight, 4_222_310, "the newest height, for the last-donation line");
});

test("a donation mixed into the same history as our own money", () => {
  // The realistic ledger, since the account does all three things.
  const history = [
    { mined_height: 4_222_150, sent_note_count: 0, outputs: [{ pool: "transparent", from_account: null, value: 625_000_000, is_change: false }] },
    { mined_height: 4_222_201, sent_note_count: 1, outputs: [{ pool: "ironwood", from_account: OURS, value: 25_719_875_000, is_change: false }] },
    donation(3),
    { mined_height: 4_222_305, sent_note_count: 1, outputs: [{ pool: "ironwood", from_account: OURS, value: 2 * TAZ, is_change: true }] },
  ];
  const t = tallyDonations(history);
  assert.equal(t.count, 1);
  assert.equal(t.zat, BigInt(3 * TAZ), "only the one transaction we did not sign");
});

test("unconfirmed and expired receipts do not count yet", () => {
  // A counter that goes DOWN when a transaction expires or is reorged away is worse
  // than one that lags a block, because the drop looks like money leaving.
  const pending = { ...donation(10), mined_height: null };
  const expired = { ...donation(10), mined_height: null, expired_unmined: true };
  assert.equal(tallyDonations([pending]).zat, 0n);
  assert.equal(tallyDonations([expired]).zat, 0n);
  assert.equal(tallyDonations([pending, expired, donation(1)]).zat, BigInt(TAZ), "the confirmed one still counts");
});

test("every pool in the allowlist is actually counted", () => {
  // Otherwise the list and the branch that reads it could drift and donations would
  // vanish for a reason no test names.
  for (const pool of DONATION_POOLS) {
    const t = tallyDonations([
      { mined_height: 1, sent_note_count: 0, outputs: [{ pool, from_account: null, value: 7 * TAZ, is_change: false }] },
    ]);
    assert.equal(t.zat, BigInt(7 * TAZ), `${pool} was not counted`);
  }
});

test("an unrecognised pool is unattributed rather than counted", () => {
  // Same reasoning as the drippable allowlist in #221: whatever gets added next is
  // not assumed to be external money just because nobody has heard of it.
  const t = tallyDonations([
    { mined_height: 1, sent_note_count: 0, outputs: [{ pool: "somethingNew", from_account: null, value: 99 * TAZ, is_change: false }] },
  ]);
  assert.equal(t.zat, 0n);
  assert.equal(t.unattributedZat, BigInt(99 * TAZ));
});

test("case does not decide attribution", () => {
  const t = tallyDonations([
    { mined_height: 1, sent_note_count: 0, outputs: [{ pool: "Ironwood", from_account: null, value: 6 * TAZ, is_change: false }] },
  ]);
  assert.equal(t.zat, BigInt(6 * TAZ), "a capitalised pool name hid a real donation");
});

test("a non-integer or negative value is refused, not rounded into the total", () => {
  // value is u64 in zallet. A float arriving here means something upstream is wrong,
  // and a public total should not absorb it.
  for (const value of [1.5, -100, Number.MAX_SAFE_INTEGER + 2, "12.5", "abc", "", undefined]) {
    const t = tallyDonations([
      { mined_height: 1, sent_note_count: 0, outputs: [{ pool: "ironwood", from_account: null, value: value as never, is_change: false }] },
    ]);
    assert.equal(t.zat, 0n, `value ${String(value)} was counted`);
  }
});

test("large totals stay exact, with no float in the path", () => {
  const big = "90071992547409910"; // > Number.MAX_SAFE_INTEGER, sent as a string
  const t = tallyDonations([
    { mined_height: 1, sent_note_count: 0, outputs: [{ pool: "ironwood", from_account: null, value: big, is_change: false }] },
  ]);
  assert.equal(t.zat, BigInt(big));
});

test("an empty or junk history is zero, not a throw", () => {
  // The page renders this. A throw here takes down /donate, which is the one page
  // that still works when the faucet is dry.
  assert.equal(tallyDonations([]).count, 0);
  assert.equal(tallyDonations([{}]).count, 0);
  assert.equal(tallyDonations([{ mined_height: 1, outputs: undefined }]).count, 0);
  assert.equal(tallyDonations([{ mined_height: 1, sent_note_count: 0, outputs: [{}] }]).count, 0);
});
