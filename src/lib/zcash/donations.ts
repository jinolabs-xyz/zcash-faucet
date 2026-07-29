/**
 * Telling a donation apart from our own money (#192).
 *
 * The issue assumed the hard part was VISIBILITY: if `FAUCET_DONATION_ADDRESS` were
 * not ours we could not see shielded donations at all. It is ours (it is the
 * `ZALLET_ACCOUNT` UA), so we can see everything. That answer creates the problem
 * the issue did not anticipate.
 *
 * The donation address is the SAME account the faucet mines into, shields into, and
 * takes change from. So "what arrived at that address" is mostly our own money:
 *
 *   - mining income, coinbase paid to a transparent receiver of this account
 *   - the reserve loop's shield sweeps, coinbase moved to our own shielded pool
 *   - change coming back from every drip we send
 *
 * On 2026-07-29 that account held 207 TAZ shielded, essentially all of it from one
 * sweep of our own mined coinbase. A counter that totals received value would have
 * published "207 TAZ donated". That is the same wrong-in-the-flattering-direction
 * number the issue set out to avoid, arriving through a different door.
 *
 * So the question each output has to answer is not "did value arrive" but "did
 * value arrive that we did not already own". Two structural filters, not one, and
 * both come from the wallet rather than from a list anyone has to maintain:
 *
 *   1. `from_account == null` plus `sent_note_count == 0`. Any transaction we built
 *      names our account as the source and counts the notes we spent. A donor's
 *      transaction cannot, because we did not sign it.
 *   2. Shielded pools only. Coinbase cannot pay a shielded output, so mining income
 *      is transparent by construction. Excluding transparent excludes it without
 *      depending on FAUCET_MINING_ADDRESS being set correctly, and a stale mining
 *      address would otherwise publish our block rewards as public generosity.
 *
 * Filter 2 costs us transparent donations, which is the direction that undercounts.
 * Those are reported separately as unattributed rather than dropped, so an operator
 * can see one arrived, and the label on the page says "shielded" so the number never
 * claims to be the whole picture.
 *
 * Field names and types here are read from zallet 0.1.0-beta.1's own
 * `WalletTxOutput`/`WalletTx` serialization, not from documentation.
 */

/** Pools where a receipt cannot be our own mined coinbase. See filter 2 above.
 *
 *  Deliberately NOT reused from DRIPPABLE_POOLS, which happens to hold the same
 *  names today. That list answers "can the faucet spend this", this one answers
 *  "could this have come from outside", and a change to either would be wrong for
 *  the other. Sprout is absent from both, for unrelated reasons. */
export const DONATION_POOLS: readonly string[] = ["ironwood", "orchard", "sapling"];

/** One output of a wallet transaction, as zallet serializes it. */
export interface WalletOutput {
  pool?: string;
  from_account?: string | null;
  to_address?: string | null;
  value?: number | string;
  is_change?: boolean;
  memo?: string | null;
}

/** One transaction touching the account, as zallet serializes it. */
export interface WalletTx {
  txid?: string;
  mined_height?: number | null;
  expired_unmined?: boolean;
  sent_note_count?: number;
  outputs?: WalletOutput[];
}

export interface DonationTally {
  /** Confirmed shielded receipts we did not fund. */
  count: number;
  zat: bigint;
  /** Height of the most recent one, for a "last donation" line. Null if none. */
  lastHeight: number | null;
  /** Inbound transparent value we cannot attribute, because at this address it is
   *  indistinguishable from mining income. Shown to operators, never published as
   *  a donation total. */
  unattributedCount: number;
  unattributedZat: bigint;
}

/** Exact zatoshi from either JSON shape, or null if it is not a whole number.
 *  zallet sends u64; a float here would mean the value is corrupt or rounded, and
 *  a public total must not quietly absorb that. */
function zat(value: number | string | undefined): bigint | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (!/^\d+$/.test(value.trim())) return null;
  return BigInt(value.trim());
}

/**
 * Attribute the account's transaction history.
 *
 * Unmined and expired transactions are skipped: an unconfirmed donation can still
 * expire or be reorged away, and a public counter that goes DOWN is worse than one
 * that lags by a block.
 */
export function tallyDonations(txs: readonly WalletTx[]): DonationTally {
  const t: DonationTally = {
    count: 0,
    zat: 0n,
    lastHeight: null,
    unattributedCount: 0,
    unattributedZat: 0n,
  };

  for (const tx of txs) {
    const height = tx.mined_height;
    if (height === null || height === undefined) continue;
    if (tx.expired_unmined) continue;

    // We spent notes in this transaction, so whatever it paid us is our own money
    // coming back. Checked per transaction because it is the stronger signal: it
    // holds even for an output whose from_account the wallet failed to fill in.
    if ((tx.sent_note_count ?? 0) > 0) continue;

    for (const out of tx.outputs ?? []) {
      if (out.from_account) continue; // funded by an account we own
      if (out.is_change) continue;

      const value = zat(out.value);
      if (value === null || value === 0n) continue;

      const pool = (out.pool ?? "").toLowerCase();
      if (DONATION_POOLS.includes(pool)) {
        t.count += 1;
        t.zat += value;
        if (t.lastHeight === null || height > t.lastHeight) t.lastHeight = height;
      } else {
        // Transparent, or a pool this zallet knows and we do not. Either way it is
        // not provably external money, so it stays out of the published number.
        t.unattributedCount += 1;
        t.unattributedZat += value;
      }
    }
  }

  return t;
}
