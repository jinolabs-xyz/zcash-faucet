/**
 * What a shielded drip can actually spend (#185).
 *
 * THE BUG THIS REPLACES. `balance()` summed every pool the wallet reported, so the
 * faucet believed it held 257 TAZ when 50 of that was unshielded coinbase a
 * `z_sendmany` to a shielded address cannot spend. The reserve loop then decided no
 * refill was needed while the drippable pool was a third of the reported figure.
 *
 * The asymmetry that dictates the design: under-reporting is cheap, visible and
 * self-correcting, because the loop sweeps and the number rises. Over-reporting
 * promises a drip the wallet cannot deliver and fails in front of a user. So the
 * tests below are mostly about what must be EXCLUDED, and about an unknown pool
 * landing on the excluded side by construction rather than by anyone remembering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RATE_LIMIT_SALT = "drippable-test-salt";
process.env.FAUCET_SENDER = "zallet";
const { drippableZat, DRIPPABLE_POOLS } = await import("./zalletsend.ts");

const TAZ = 100_000_000n;

test("the live wallet's own shape: transparent is excluded, ironwood counted", () => {
  // The exact figures from the 2026-07-29 recovery, before the sweep. The old code
  // returned 257.2 here and the reserve loop believed it.
  const zat = drippableZat({
    transparent: { valueZat: "5000125000" }, //  50.00125 TAZ, not drippable
    ironwood: { valueZat: "20719875000" }, //   207.19875 TAZ, drippable
  });
  assert.equal(zat, 20_719_875_000n, "only the shielded pool is spendable by a drip");
  assert.notEqual(zat, 25_720_000_000n, "the old total must not come back");
});

test("an UNRECOGNISED pool is excluded, which is the point of an allowlist", () => {
  // A denylist would have admitted this. Whatever Zcash or zallet adds next must not
  // be assumed spendable just because nobody has heard of it.
  const zat = drippableZat({
    ironwood: { valueZat: String(10n * TAZ) },
    somethingNew: { valueZat: String(500n * TAZ) },
  });
  assert.equal(zat, 10n * TAZ, "the unknown pool's 500 TAZ must not be promised to anyone");
});

test("sprout is shielded and still excluded, because those funds are stranded", () => {
  // Counting them would promise drips we cannot make, which is the failure the list
  // exists to prevent, so being shielded is not sufficient.
  const zat = drippableZat({
    ironwood: { valueZat: String(3n * TAZ) },
    sprout: { valueZat: String(99n * TAZ) },
  });
  assert.equal(zat, 3n * TAZ);
});

test("every pool in the allowlist is actually counted", () => {
  // Otherwise the list could drift out of step with the loop that reads it and the
  // balance would under-report for a reason no test names.
  for (const name of DRIPPABLE_POOLS) {
    assert.equal(drippableZat({ [name]: { valueZat: String(7n * TAZ) } }), 7n * TAZ, `${name} should count`);
  }
});

test("multiple shielded pools add up", () => {
  const zat = drippableZat({
    ironwood: { valueZat: String(2n * TAZ) },
    sapling: { valueZat: String(3n * TAZ) },
    transparent: { valueZat: String(100n * TAZ) },
  });
  assert.equal(zat, 5n * TAZ);
});

test("a pool with no valueZat is skipped rather than counted as zero or crashing", () => {
  // The wallet reports an empty object for a pool it has nothing in.
  const zat = drippableZat({
    ironwood: { valueZat: String(4n * TAZ) },
    transparent: {},
    sapling: {},
  });
  assert.equal(zat, 4n * TAZ);
});

test("no pools at all is zero, not a throw", () => {
  // A guard that crashes on an empty wallet would take the faucet down at exactly
  // the moment it has nothing to give, which is when it most needs to say so.
  assert.equal(drippableZat({}), 0n);
});

test("case does not decide spendability", () => {
  // If the wallet capitalises a pool name differently we must not silently exclude
  // real money, which would look like an empty faucet.
  assert.equal(drippableZat({ Ironwood: { valueZat: String(6n * TAZ) } }), 6n * TAZ);
  assert.equal(drippableZat({ TRANSPARENT: { valueZat: String(6n * TAZ) } }), 0n);
});

test("the total is exact in zatoshi, with no float in the path", () => {
  // The wallet sends these as strings precisely so large values survive. A Number
  // round-trip here would corrupt a balance above 2^53 zatoshi.
  const big = "90071992547409910"; // > Number.MAX_SAFE_INTEGER
  assert.equal(drippableZat({ ironwood: { valueZat: big } }), BigInt(big));
});
