/**
 * What each external reference says, whether they agree, and which one a node is judged
 * against (#548).
 *
 * The 13:06Z case on 2026-09-15 is the one these tests exist for: readiness passed a
 * resyncing node as current for three minutes because the single reference it asked was
 * 113 blocks behind the network, while a second source knew better and nothing consulted
 * it. So the cases below are written in those terms rather than in round numbers.
 *
 * Time is injected everywhere. A test that asked how old a cache entry is at assert time
 * would go red on a slow machine for a reason unrelated to the rule under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { getTipReferences, referenceTip, resetExternalTipForTests, REFERENCE_MAX_AGE_MS, AGREE_BLOCKS } =
  await import("./externalTip.ts");

const NOW = Date.parse("2026-09-15T13:06:00Z");
type Src = { height: number; at: number; host: string | null };
const g = globalThis as unknown as { __faucetTipSources?: Record<string, Src> };

/** Plant the per-source cache the background refresh fills. Ages are relative to NOW. */
function plant(sources: Record<string, { height: number; ageMs: number; host?: string | null }>) {
  resetExternalTipForTests();
  g.__faucetTipSources = Object.fromEntries(
    Object.entries(sources).map(([k, v]) => [k, { height: v.height, at: NOW - v.ageMs, host: v.host ?? null }]),
  );
}

test("with no reference ever fetched, there is nothing to judge against and nothing is stale", () => {
  resetExternalTipForTests();
  const r = referenceTip(NOW);
  assert.deepEqual(r, { height: null, source: null, stale: false });
  const refs = getTipReferences(NOW);
  assert.deepEqual(refs.sources, {});
  assert.equal(refs.spreadBlocks, null);
  assert.equal(refs.corroborated, null, "cannot tell is null, never false");
  assert.equal(refs.used, null);
});

test("two fresh references that agree: corroborated, and the higher one is used", () => {
  plant({ hosh: { height: 4_349_918, ageMs: 12_000 }, lightwalletd: { height: 4_349_928, ageMs: 34_000, host: "testnet.zec.rocks:443" } });
  const refs = getTipReferences(NOW);
  assert.equal(refs.spreadBlocks, 10);
  assert.equal(refs.corroborated, true);
  assert.equal(refs.used, "lightwalletd", "the max, not the aggregate by preference");
  assert.equal(refs.sources.hosh?.ageSeconds, 12);
  assert.equal(refs.sources.lightwalletd?.ageSeconds, 34);
  assert.equal(refs.sources.lightwalletd?.host, "testnet.zec.rocks:443");
  assert.equal(referenceTip(NOW).height, 4_349_928);
  assert.equal(referenceTip(NOW).source, "lightwalletd");
});

test("THE 13:06Z CASE: a source 113 blocks behind cannot pass a node the other source says is behind", () => {
  // hosh stuck at 4,349,600 while our own endpoint read 4,349,713. Our node was at
  // 4,349,563: 37 short of the stale reference, 150 short of the real tip.
  plant({ hosh: { height: 4_349_600, ageMs: 5_000 }, lightwalletd: { height: 4_349_713, ageMs: 5_000 } });
  const refs = getTipReferences(NOW);
  assert.equal(refs.used, "lightwalletd", "the node is judged against the higher reference");
  assert.equal(referenceTip(NOW).height, 4_349_713);
  assert.equal(refs.spreadBlocks, 113);
  assert.equal(refs.corroborated, false, "113 blocks apart is not agreement");
  // And the fetch ages say nothing about it, which is the limit this block is honest
  // about: hosh publishes no timestamp, so a fresh fetch of a stale number looks fresh.
  assert.equal(refs.sources.hosh?.stale, false, "our fetch was seconds old; hosh's number was not");
});

test("the staleness bound is a boundary, and it is OUR fetch age", () => {
  plant({ hosh: { height: 4_000_000, ageMs: REFERENCE_MAX_AGE_MS } });
  assert.equal(getTipReferences(NOW).sources.hosh?.stale, false, "exactly at the bound is still usable");
  assert.equal(referenceTip(NOW).height, 4_000_000);

  plant({ hosh: { height: 4_000_000, ageMs: REFERENCE_MAX_AGE_MS + 1 } });
  assert.equal(getTipReferences(NOW).sources.hosh?.stale, true, "one millisecond past it is not");
  assert.deepEqual(referenceTip(NOW), { height: null, source: null, stale: true },
    "we looked and the answer is too old, which is not the same as never having looked");
});

test("a stale reference is still reported, and still cannot be used", () => {
  plant({
    hosh: { height: 4_349_900, ageMs: REFERENCE_MAX_AGE_MS + 60_000 },
    lightwalletd: { height: 4_349_700, ageMs: 10_000 },
  });
  const refs = getTipReferences(NOW);
  assert.equal(refs.sources.hosh?.stale, true);
  assert.equal(refs.sources.hosh?.height, 4_349_900, "reported, because an operator wants to see it");
  assert.equal(refs.used, "lightwalletd", "but the fresh lower one is what a node is judged against");
  assert.equal(refs.spreadBlocks, null, "one usable source is not a spread");
  assert.equal(refs.corroborated, null, "and it is not disagreement either");
});

test("agreement is a boundary too", () => {
  plant({ hosh: { height: 4_000_000, ageMs: 1000 }, lightwalletd: { height: 4_000_000 + AGREE_BLOCKS, ageMs: 1000 } });
  assert.equal(getTipReferences(NOW).corroborated, true, "exactly at the bound still agrees");
  plant({ hosh: { height: 4_000_000, ageMs: 1000 }, lightwalletd: { height: 4_000_000 + AGREE_BLOCKS + 1, ageMs: 1000 } });
  assert.equal(getTipReferences(NOW).corroborated, false, "one block past it does not");
});

test("a source that is absent this round keeps its last answer and ages out of use", () => {
  // The refresh keeps the previous value when a source fails, so the age is what turns an
  // outage into an honest "stale" rather than a sudden hole.
  plant({ hosh: { height: 4_349_918, ageMs: REFERENCE_MAX_AGE_MS + 1 }, lightwalletd: { height: 4_349_920, ageMs: REFERENCE_MAX_AGE_MS + 1 } });
  const refs = getTipReferences(NOW);
  assert.equal(refs.used, null, "nothing fresh enough to judge a node against");
  assert.equal(refs.spreadBlocks, null, "two stale sources are not a corroboration");
  assert.equal(refs.corroborated, null);
  assert.equal(referenceTip(NOW).stale, true);
});
