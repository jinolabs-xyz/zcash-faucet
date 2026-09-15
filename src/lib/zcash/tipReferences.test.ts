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

// The production readers KICK a background refresh, so the oracle is pinned at a closed
// port and the direct list emptied before the import: a unit test must never be able to
// reach the real hosh. The kick's own case below asserts the attempt was STARTED, which is
// observable without any of it having to succeed.
process.env.HOSH_URL = "http://127.0.0.1:9/";
process.env.TIP_ORACLE_ENDPOINT = "";

const { getTipReferences, referenceTipAt, referenceTip, readTipReferences, resetExternalTipForTests, REFERENCE_MAX_AGE_MS, AGREE_BLOCKS } =
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
  const r = referenceTipAt(NOW);
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
  assert.equal(referenceTipAt(NOW).height, 4_349_928);
  assert.equal(referenceTipAt(NOW).source, "lightwalletd");
});

test("THE 13:06Z CASE: a source 113 blocks behind cannot pass a node the other source says is behind", () => {
  // hosh stuck at 4,349,600 while our own endpoint read 4,349,713. Our node was at
  // 4,349,563: 37 short of the stale reference, 150 short of the real tip.
  plant({ hosh: { height: 4_349_600, ageMs: 5_000 }, lightwalletd: { height: 4_349_713, ageMs: 5_000 } });
  const refs = getTipReferences(NOW);
  assert.equal(refs.used, "lightwalletd", "the node is judged against the higher reference");
  assert.equal(referenceTipAt(NOW).height, 4_349_713);
  assert.equal(refs.spreadBlocks, 113);
  assert.equal(refs.corroborated, false, "113 blocks apart is not agreement");
  // And the fetch ages say nothing about it, which is the limit this block is honest
  // about: hosh publishes no timestamp, so a fresh fetch of a stale number looks fresh.
  assert.equal(refs.sources.hosh?.stale, false, "our fetch was seconds old; hosh's number was not");
});

test("usedHeight is the height of the source `used` names, flat, for a reader that cannot nest", () => {
  // The watchdog parses with grep, sed and cut by design, so tipReferences.sources[used]
  // .height is out of reach two levels down and reaching for it with a brace-bounded grep
  // is the #391 greedy-regex lesson volunteered (SDE-Infra, writing the consumer). The
  // field is redundant on purpose; what matters is that it cannot disagree with `used`.
  plant({ hosh: { height: 4_349_918, ageMs: 12_000 }, lightwalletd: { height: 4_349_928, ageMs: 34_000 } });
  const refs = getTipReferences(NOW);
  assert.equal(refs.used, "lightwalletd");
  assert.equal(refs.usedHeight, 4_349_928);
  assert.equal(refs.usedHeight, refs.sources[refs.used!]!.height, "the two must always tell one story");
  assert.equal(refs.usedHeight, referenceTipAt(NOW).height, "and the same one referenceTip judges against");

  // Null WITH used, never a stale height left standing beside a null name.
  plant({ hosh: { height: 4_349_918, ageMs: REFERENCE_MAX_AGE_MS + 1 } });
  const stale = getTipReferences(NOW);
  assert.equal(stale.used, null);
  assert.equal(stale.usedHeight, null, "no usable source means no height, not the stale one");

  resetExternalTipForTests();
  assert.equal(getTipReferences(NOW).usedHeight, null, "and nothing fetched at all is null too");
});

test("the staleness bound is a boundary, and it is OUR fetch age", () => {
  plant({ hosh: { height: 4_000_000, ageMs: REFERENCE_MAX_AGE_MS } });
  assert.equal(getTipReferences(NOW).sources.hosh?.stale, false, "exactly at the bound is still usable");
  assert.equal(referenceTipAt(NOW).height, 4_000_000);

  plant({ hosh: { height: 4_000_000, ageMs: REFERENCE_MAX_AGE_MS + 1 } });
  assert.equal(getTipReferences(NOW).sources.hosh?.stale, true, "one millisecond past it is not");
  assert.deepEqual(referenceTipAt(NOW), { height: null, source: null, stale: true },
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
  // AND THE FLAT FIELD SAYS THE SAME, here, where the distinction is most visible: a
  // higher STALE source sits beside a lower fresh one, so a usedHeight taken from the
  // wrong set reads 4,349,900 next to a `used` that names the other source.
  //
  // WITHOUT THIS LINE A RECOMPUTE SURVIVES, and it is worth being exact about which one,
  // because I got it wrong once. `used ? max(all sources) : null` - GUARDED, so the
  // ternary short-circuits on the stale-only case below - passed the whole suite until
  // this assertion existed. The guard-LESS variant does fail below, which is what I
  // measured when I first disputed the finding; two different mutants, and the one the
  // CTO's red-team meant was the one that survives. Measured both ways: guarded is green
  // without this line and red with it.
  assert.equal(refs.usedHeight, 4_349_700, "the flat height follows `used`, not the highest number present");
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
  assert.equal(referenceTipAt(NOW).stale, true);
});

/** Ages relative to the REAL clock: the kicking readers take their own Date.now(), where
 *  every case above injects the fixed instant. Planting against NOW here would make a
 *  five-second-old cache look hours old, and the first assertion would be measuring the
 *  wall clock rather than the rule. */
function plantLive(sources: Record<string, { height: number; ageMs: number }>) {
  resetExternalTipForTests();
  (globalThis as unknown as { __faucetTipSources?: Record<string, Src> }).__faucetTipSources =
    Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { height: v.height, at: Date.now() - v.ageMs, host: null }]));
}

test("A READ KICKS THE REFRESH once the cache is getting old, which is what keeps a quiet faucet watched", async () => {
  // THE REGRESSION THIS PR SHIPPED AND THE REVIEW CAUGHT. getExternalTipReading() has
  // always been a read that also kicks a refresh past STALE_MS, and it was reached on every
  // status poll. Moving the readers to the reference rules took the last kick off the
  // polling path: 4 oracle fetches in 95 s before, 1 after. Five minutes of that and every
  // reference is stale, readiness fails open, and nothing is asking any more.
  //
  // Observed through the attempt marker rather than through a fetch: refresh() stamps it
  // before doing any network work, so the kick is provable while the oracle is a closed
  // port.
  const gg = globalThis as unknown as { __faucetTipLastAttemptAt?: number };

  plantLive({ hosh: { height: 4_000_000, ageMs: 5_000 } });
  delete gg.__faucetTipLastAttemptAt;
  referenceTip();
  assert.equal(gg.__faucetTipLastAttemptAt, undefined, "a five-second-old cache is fresh: no kick");

  plantLive({ hosh: { height: 4_000_000, ageMs: 31_000 } });
  delete gg.__faucetTipLastAttemptAt;
  referenceTip();
  assert.equal(typeof gg.__faucetTipLastAttemptAt, "number", "a 31-second-old cache kicks a refresh");

  // And the /api/ready accessor kicks too: it is the one on the polling path.
  plantLive({ hosh: { height: 4_000_000, ageMs: 31_000 } });
  delete gg.__faucetTipLastAttemptAt;
  readTipReferences();
  assert.equal(typeof gg.__faucetTipLastAttemptAt, "number", "the status path kicks as well");

  // A cold cache is stale too: boot's warm can fail, and a reader must not sit on nothing.
  resetExternalTipForTests();
  delete gg.__faucetTipLastAttemptAt;
  referenceTip();
  assert.equal(typeof gg.__faucetTipLastAttemptAt, "number", "no sources at all also kicks");
});
