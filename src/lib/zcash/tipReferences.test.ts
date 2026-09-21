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
// The THIRD leg: chainIdentityOracle dials LIGHTWALLETD_ENDPOINT directly (config.ts:116).
process.env.LIGHTWALLETD_ENDPOINT = "https://127.0.0.1:9";

const { getTipReferences, referenceTipAt, referenceTip, readTipReferences, resetExternalTipForTests, REFERENCE_MAX_AGE_MS, AGREE_BLOCKS, AGREE_SECONDS, observedSecondsPerBlock, rateAnchor } =
  await import("./externalTip.ts");

const NOW = Date.parse("2026-09-15T13:06:00Z");
type Src = { height: number; at: number; host: string | null; prevHeight?: number; prevAt?: number };
const g = globalThis as unknown as { __faucetTipSources?: Record<string, Src> };

/** Plant the per-source cache the background refresh fills. Ages are relative to NOW. */
function plant(
  sources: Record<string, { height: number; ageMs: number; host?: string | null; wasHeight?: number; wasAgeMs?: number }>,
) {
  resetExternalTipForTests();
  g.__faucetTipSources = Object.fromEntries(
    Object.entries(sources).map(([k, v]) => [
      k,
      {
        height: v.height,
        at: NOW - v.ageMs,
        host: v.host ?? null,
        // The previous sample, which is the only thing a block RATE can be observed from.
        ...(v.wasHeight != null && v.wasAgeMs != null ? { prevHeight: v.wasHeight, prevAt: NOW - v.wasAgeMs } : {}),
      },
    ]),
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

test("each source's height is flat too, so the watchdog can print WHY it could not tell", () => {
  // #600 step 3, SDE-Infra writing the consumer. When `corroborated` is false the watchdog's
  // journal says only "cannot tell", and the issue asks it to print the spread and the two
  // heights it saw so an incident can be read without the app. Those live two levels down under
  // `sources.hosh.height`, which is the reach `usedHeight` already exists to avoid.
  plant({ hosh: { height: 4_349_918, ageMs: 12_000 }, lightwalletd: { height: 4_349_928, ageMs: 34_000 } });
  const refs = getTipReferences(NOW);
  assert.equal(refs.hoshHeight, 4_349_918);
  assert.equal(refs.lightwalletdHeight, 4_349_928);
  // THE THREE NUMBERS MUST BE ON ONE CLOCK. A reader subtracting the two flat heights has to
  // get the spread; if these were sampled separately from the spread they could disagree and
  // the journal line would be self-contradicting at exactly the moment someone is reading it.
  assert.equal(
    Math.abs(refs.lightwalletdHeight! - refs.hoshHeight!), refs.spreadBlocks,
    "the flat heights must reproduce spreadBlocks, or the journal line contradicts itself",
  );
  assert.equal(refs.hoshHeight, refs.sources.hosh!.height);
  assert.equal(refs.lightwalletdHeight, refs.sources.lightwalletd!.height);
});

test("a source that never answered is null; one that answered and went stale keeps its height", () => {
  // MY FIRST VERSION OF THIS ASSERTED THE OPPOSITE and the suite refused it, correctly. I wrote
  // `stale.hoshHeight === null` on the reasoning that a watchdog must tell a DARK reference from
  // a LAGGING one. The reasoning is sound and the design decision was already made the other way:
  // `sources` reports a stale entry WITH its height and marks it unusable -- there is a row for it
  // above, "a stale reference is still reported, and still cannot be used" -- because the height a
  // dark source last knew is evidence, and throwing it away to encode one bit loses it.
  //
  // So the flat field MIRRORS `sources` exactly and adds no opinion. Usability is already carried
  // by `used` and `usedHeight`, which go null together; a consumer asking "may I judge against
  // this" reads those, and one asking "what did each source last say" reads these.
  plant({ hosh: { height: 4_349_918, ageMs: REFERENCE_MAX_AGE_MS + 1 }, lightwalletd: { height: 4_349_928, ageMs: 10_000 } });
  const stale = getTipReferences(NOW);
  assert.equal(stale.hoshHeight, 4_349_918, "a stale source keeps the height it last reported");
  assert.equal(stale.hoshHeight, stale.sources.hosh!.height, "flat mirrors nested, with no opinion of its own");
  assert.equal(stale.used, "lightwalletd", "and staleness is carried by `used`, not by the height");
  assert.equal(stale.lightwalletdHeight, 4_349_928);

  plant({ lightwalletd: { height: 4_349_928, ageMs: 10_000 } });
  const absent = getTipReferences(NOW);
  assert.equal(absent.hoshHeight, null, "a source that never answered is null, not 0");
  assert.equal(absent.lightwalletdHeight, 4_349_928);

  // AND THE ANTI-VACUITY PARTNER: every assertion above is `=== null`, which a field that was
  // ALWAYS null would satisfy perfectly. This is the case where hosh does answer.
  plant({ hosh: { height: 4_349_900, ageMs: 5_000 }, lightwalletd: { height: 4_349_928, ageMs: 10_000 } });
  assert.equal(getTipReferences(NOW).hoshHeight, 4_349_900, "hoshHeight is not simply always null");
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

/* --- the tolerance is a TIME, because the disagreement is one (#600 step 2) --- */

test("#600: the SAME block spread agrees at a fast cadence and disagrees at a slow one", () => {
  // The whole bug in one case. A block count cannot express an indexer that runs behind by
  // a roughly fixed interval: step 1 measured p50 8 blocks but 70 SECONDS, so the seconds
  // figure is the stable one. 40 blocks is under seven minutes while testnet makes a block
  // every 10 s, and over half an hour at 50 s.
  plant({
    hosh: { height: 4_000_000, ageMs: 1000, wasHeight: 3_999_900, wasAgeMs: 1_001_000 },  // 100 blocks / 1000 s = 10 s
    lightwalletd: { height: 4_000_040, ageMs: 1000 },
  });
  const fast = getTipReferences(NOW);
  assert.equal(fast.spreadBlocks, 40);
  assert.equal(fast.secondsPerBlock, 10);
  assert.equal(fast.spreadSeconds, 400);
  assert.equal(fast.corroborated, false, "400 s is past the 300 s tolerance");

  plant({
    hosh: { height: 4_000_000, ageMs: 1000, wasHeight: 3_999_980, wasAgeMs: 101_000 },    // 20 blocks / 100 s = 5 s
    lightwalletd: { height: 4_000_040, ageMs: 1000 },
  });
  const faster = getTipReferences(NOW);
  assert.equal(faster.spreadBlocks, 40, "the same forty blocks");
  assert.equal(faster.secondsPerBlock, 5);
  assert.equal(faster.spreadSeconds, 200);
  assert.equal(faster.corroborated, true, "at twice the cadence the same gap is half the time");
});

test("#600 THE PARTNER: the old block rule would have refused BOTH readings above", () => {
  // This row used to be `assert.ok(40 > AGREE_BLOCKS)` and never called the module at all. It
  // passed on main, on the unfixed branch and on every mutant, which is the definition of a row
  // that holds nothing. It now drives the real rule: with no rate to convert through, the same
  // 40-block spread that the case above accepts at 5 s a block is REFUSED, so the rate is
  // provably what changed the verdict rather than something about the number 40.
  plant({ hosh: { height: 4_000_000, ageMs: 1000 }, lightwalletd: { height: 4_000_040, ageMs: 1000 } });
  const noRate = getTipReferences(NOW);
  assert.equal(noRate.secondsPerBlock, null);
  assert.equal(noRate.corroborated, false, "40 blocks breaches the old count, which is the fallback");
});

test("#600: with no rate observed yet the block tolerance still answers, rather than a guess", () => {
  // The first poll or two after a restart. Converting through the nominal 75 s target would
  // inflate every spread by six on a testnet making blocks every 10 s.
  plant({ hosh: { height: 4_000_000, ageMs: 1000 }, lightwalletd: { height: 4_000_000 + AGREE_BLOCKS, ageMs: 1000 } });
  const refs = getTipReferences(NOW);
  assert.equal(refs.secondsPerBlock, null);
  assert.equal(refs.spreadSeconds, null, "null seconds is how a reader tells which rule answered");
  assert.equal(refs.corroborated, true, "exactly at the block bound, as before");
});

test("#600: a source that has not moved gives no rate, rather than a divide by zero", () => {
  plant({
    hosh: { height: 4_000_000, ageMs: 1000, wasHeight: 4_000_000, wasAgeMs: 601_000 },
    lightwalletd: { height: 4_000_010, ageMs: 1000 },
  });
  assert.equal(getTipReferences(NOW).secondsPerBlock, null);
  assert.equal(observedSecondsPerBlock({ hosh: { height: 5, at: 10, prevHeight: 5, prevAt: 0 } }), null);
  assert.equal(observedSecondsPerBlock({ hosh: { height: 9, at: 10, prevHeight: 5, prevAt: 10 } }), null, "no elapsed time either");
});

test("#600: the tolerance is a boundary in seconds", () => {
  const atBound = (spread: number) => {
    plant({
      hosh: { height: 4_000_000, ageMs: 1000, wasHeight: 3_999_900, wasAgeMs: 1_001_000 },  // 10 s a block
      lightwalletd: { height: 4_000_000 + spread, ageMs: 1000 },
    });
    return getTipReferences(NOW);
  };
  assert.equal(atBound(AGREE_SECONDS / 10).spreadSeconds, AGREE_SECONDS);
  assert.equal(atBound(AGREE_SECONDS / 10).corroborated, true, "exactly at the bound still agrees");
  assert.equal(atBound(AGREE_SECONDS / 10 + 1).corroborated, false, "one block past it does not");
});

/* --- the rate anchor: measured over minutes of chain, not one poll (#600 step 2) --- */

test("#600: the anchor is HELD, so the rate is never measured across a single poll", () => {
  // The weakness a one-poll rate has: at a 30 s refresh and 10 s blocks each sample sees three
  // blocks, and a patch producing one reads 30 s a block and trebles every spread - which can
  // flip corroborated to false, the exact noise this change removes.
  const t0 = NOW - 600_000;
  let src = { height: 4_000_000, at: t0, ...rateAnchor(undefined, 4_000_000, t0) };
  assert.equal(src.prevAt, undefined, "the first reading has nothing to anchor to yet");

  // Second reading: nothing held, so this one becomes the anchor.
  const t1 = t0 + 30_000;
  src = { height: 4_000_003, at: t1, ...rateAnchor(src, 4_000_003, t1) };
  assert.equal(src.prevHeight, 4_000_000);
  assert.equal(src.prevAt, t0);

  // Every poll for the next five minutes keeps that SAME anchor rather than stepping forward.
  let t = t1;
  for (let i = 0; i < 8; i++) {
    t += 30_000;
    src = { height: src.height + 3, at: t, ...rateAnchor(src, src.height + 3, t) };
  }
  assert.equal(src.prevAt, t0, "still anchored to the first sample, four minutes on");
  assert.equal(src.prevHeight, 4_000_000);

  // Past the baseline it finally steps, and the new anchor is the reading it stepped from.
  const tLate = t0 + 5 * 60_000 + 1_000;
  const before = { ...src };
  src = { height: src.height + 3, at: tLate, ...rateAnchor(src, src.height + 3, tLate) };
  assert.equal(src.prevAt, before.at, "the anchor advances to the previous reading, not to now");
  assert.equal(src.prevHeight, before.height);
});

test("#600 THE PARTNER: a held anchor is not a FROZEN one", () => {
  // Without this, never advancing the anchor at all satisfies the case above, and the rate
  // would be measured from the process's first ever poll for the life of the box.
  const t0 = 1_000_000;
  let src: { height: number; at: number; prevHeight?: number; prevAt?: number } =
    { height: 100, at: t0, prevHeight: 90, prevAt: t0 - 6 * 60_000 };
  src = { height: 110, at: t0 + 1000, ...rateAnchor(src, 110, t0 + 1000) };
  assert.equal(src.prevAt, t0, "an anchor past the baseline DOES move");
  assert.equal(src.prevHeight, 100);
});

test("#600: a source that repeats its height does not move the anchor", () => {
  const t0 = 1_000_000;
  const stale = { height: 100, at: t0, prevHeight: 90, prevAt: t0 - 6 * 60_000 };
  const out = rateAnchor(stale, 100, t0 + 1000);
  assert.equal(out.prevHeight, 90, "nothing advanced, because nothing moved");
  assert.equal(out.prevAt, t0 - 6 * 60_000);
});

/* --- what the rate is computed FROM (#600 step 2, review findings) --- */

test("#600: the rate is POOLED across sources, not an average of their rates", () => {
  // Averaging over-weights whichever source saw fewer blocks. One advancing 1 block in 30 s
  // beside one advancing 10 gives a mean of 16.5 s a block, where the chain plainly produced
  // 11 blocks in 60 s, which is 5.45. Review measured that arithmetic refusing a 20-block
  // spread at 330 s that the pooled figure grants at 109 s.
  const pooled = observedSecondsPerBlock({
    hosh: { height: 101, at: 30_000, prevHeight: 100, prevAt: 0 },          // 1 block / 30 s
    lightwalletd: { height: 110, at: 30_000, prevHeight: 100, prevAt: 0 },  // 10 blocks / 30 s
  });
  assert.ok(pooled != null);
  assert.ok(Math.abs(pooled - 60 / 11) < 0.01, `pooled should be 60s/11 blocks, got ${pooled}`);
  assert.ok(pooled < 6, "an average of the two rates would be 16.5, which is the bug");
});

test("#600: a STALE source does not get a vote on the rate", () => {
  // It is excluded from the spread, so it must not set the rate the spread is judged by. A
  // source dark for minutes keeps the height it last reported, and its window stretches over
  // the whole outage: review measured a six-minute-dark hosh contributing 900 s a block.
  plant({
    hosh: { height: 4_000_000, ageMs: REFERENCE_MAX_AGE_MS + 60_000, wasHeight: 3_999_990, wasAgeMs: REFERENCE_MAX_AGE_MS + 960_000 },
    lightwalletd: { height: 4_000_100, ageMs: 1000, wasHeight: 4_000_000, wasAgeMs: 1_001_000 },  // 100 blocks / 1000 s = 10
  });
  const refs = getTipReferences(NOW);
  assert.equal(refs.secondsPerBlock, 10, "only the fresh source sets the rate");
});

test("#600: the published rate is the one the spread was computed FROM", () => {
  // The field's promise is that a reading can be reproduced from the journal. Rounding the
  // published number while converting with the unrounded one broke it: review measured
  // spreadBlocks 500 and secondsPerBlock 0 published beside spreadSeconds 200. Driven with a
  // rate a real chain produces (10.456 s a block) so the clamp below is not what is under test.
  plant({
    hosh: { height: 4_000_000, ageMs: 1000, wasHeight: 3_999_000, wasAgeMs: 10_457_000 },  // 1000 blocks / 10456 s
    lightwalletd: { height: 4_000_500, ageMs: 1000 },
  });
  const refs = getTipReferences(NOW);
  assert.equal(refs.secondsPerBlock, 10.46, "rounded to two places, not to an integer");
  assert.equal(refs.spreadSeconds, Math.round(refs.spreadBlocks! * refs.secondsPerBlock!), "the journal reproduces");
});

test("#600: a rate no chain produces is NOT a rate (review of #655)", () => {
  // A reference CATCHING UP after an outage measures 30,000 blocks across one anchor window,
  // which is 0.01 s a block. That made agreeBlocks 30,000, and the watchdog sizes its
  // confirmed-lag limit off that field - so an implausible rate would have raised a limit that
  // authorises rewinding chain state to 30,005 and switched the rung off entirely.
  plant({
    hosh: { height: 4_030_000, ageMs: 1000, wasHeight: 4_000_000, wasAgeMs: 301_000 },  // 0.01 s a block
    lightwalletd: { height: 4_030_005, ageMs: 1000 },
  });
  const refs = getTipReferences(NOW);
  assert.equal(refs.secondsPerBlock, null, "a source catching up is not a fast chain");
  assert.equal(refs.spreadSeconds, null);
  assert.equal(refs.agreeBlocks, AGREE_BLOCKS, "and the tolerance falls back to the block bound");
});

test("#600 THE PARTNER: a plausibly fast chain is still believed", () => {
  // Without this, clamping everything satisfies the row above and the seconds rule never runs.
  // Testnet has been making a block every 9-13 s; that must survive the clamp untouched.
  plant({
    hosh: { height: 4_000_000, ageMs: 1000, wasHeight: 3_999_900, wasAgeMs: 901_000 },  // 9 s a block
    lightwalletd: { height: 4_000_010, ageMs: 1000 },
  });
  const refs = getTipReferences(NOW);
  assert.equal(refs.secondsPerBlock, 9);
  assert.equal(refs.agreeBlocks, Math.round(AGREE_SECONDS / 9));
});

test("#600: a source that went BACKWARDS in a reorg contributes no rate", () => {
  // A negative delta is real: a reference reorgs and reports a lower height than last time.
  // Accepting it would pool negative blocks against positive seconds and produce a rate with
  // the wrong sign, or cancel a real source out entirely.
  assert.equal(
    observedSecondsPerBlock({ hosh: { height: 90, at: 30_000, prevHeight: 100, prevAt: 0 } }),
    null,
    "one source, going backwards: no rate at all rather than a negative one",
  );
  const withGood = observedSecondsPerBlock({
    hosh: { height: 90, at: 30_000, prevHeight: 100, prevAt: 0 },          // reorged, ignored
    lightwalletd: { height: 110, at: 30_000, prevHeight: 100, prevAt: 0 }, // 10 blocks / 30 s
  });
  assert.equal(withGood, 3, "and the healthy source still answers, undiluted by the reorged one");
});

test("#600: the tolerance we are applying is published IN BLOCKS, for consumers that count blocks", () => {
  // The watchdog's stall floor has to clear the gap the app calls agreement, and its comment
  // derives 25 from TIP_AGREE_BLOCKS being 20. Once the tolerance is a time that derivation
  // cannot be a literal: the same 300 s is 30 blocks at a 10 s cadence and 4 at 75 s.
  plant({
    hosh: { height: 4_000_000, ageMs: 1000, wasHeight: 3_999_900, wasAgeMs: 1_001_000 },  // 10 s a block
    lightwalletd: { height: 4_000_005, ageMs: 1000 },
  });
  assert.equal(getTipReferences(NOW).agreeBlocks, AGREE_SECONDS / 10);

  plant({
    hosh: { height: 4_000_000, ageMs: 1000, wasHeight: 3_999_900, wasAgeMs: 7_501_000 },  // 75 s a block
    lightwalletd: { height: 4_000_005, ageMs: 1000 },
  });
  assert.equal(getTipReferences(NOW).agreeBlocks, AGREE_SECONDS / 75, "the SAME tolerance, far fewer blocks");
});

test("#600 THE PARTNER: with no rate it reports the fallback bound, not a guess", () => {
  plant({ hosh: { height: 4_000_000, ageMs: 1000 }, lightwalletd: { height: 4_000_005, ageMs: 1000 } });
  const refs = getTipReferences(NOW);
  assert.equal(refs.secondsPerBlock, null);
  assert.equal(refs.agreeBlocks, AGREE_BLOCKS, "the bound that is actually deciding on this path");
});
