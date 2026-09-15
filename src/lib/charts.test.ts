/**
 * The analytics geometry.
 *
 * These assert the decisions the owner actually ruled on - labels that never collide,
 * quiet days that stay visible, today's bar being today's - as numbers, because a canvas
 * cannot be asked any of that after the fact. A screenshot check on these charts can
 * only report that something was painted, and something was painted is true of every
 * broken version of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  barMetrics,
  barRects,
  barMax,
  isMonday,
  mondayLabel,
  sevenDayMean,
  logPosition,
  tickLabel,
  reserveTargetPlacement,
  segmentRects,
  RESERVE_TICKS,
  type DripDay,
} from "./charts.ts";

const PROD = JSON.parse(readFileSync(new URL("./fixtures/status.prod.json", import.meta.url), "utf8"));
const SERIES: DripDay[] = PROD.drips.byDay;

/* ── the daily bars ───────────────────────────────────────────────────── */

test("bars fill the width exactly, at every width the layout can produce", () => {
  for (const width of [320, 400, 560, 900, 1200]) {
    const { barWidth, gap } = barMetrics(30, width);
    const spanned = barWidth * 30 + gap * 29;
    assert.ok(Math.abs(spanned - width) < 1e-9, `30 bars span ${spanned} of ${width}`);
    assert.ok(barWidth > 0, `bar width ${barWidth} at ${width}px`);
  }
});

test("bars never overlap and keep their order", () => {
  const rects = barRects(SERIES, 26, 10, 400, 108);
  assert.equal(rects.length, 30);
  for (let i = 1; i < rects.length; i++) {
    // Today's bar is deliberately 10% wider and starts 5% early, so compare against the
    // previous bar's right edge rather than assuming a uniform pitch.
    assert.ok(rects[i].x >= rects[i - 1].x, `bar ${i} starts before bar ${i - 1}`);
    assert.ok(rects[i].x >= rects[i - 1].x + rects[i - 1].w - 0.01, `bar ${i} overlaps bar ${i - 1}`);
  }
});

test("a day with no drips is still drawn, because the series zero-fills on purpose", () => {
  // The counter behind this zero-fills so quiet days are countable. Dropping them here
  // would throw that away one layer above where it was paid for: a month with a gap in
  // the middle would draw identically to a month that has no entry for that day.
  const quiet: DripDay[] = [{ day: "2026-09-01", sent: 0 }, { day: "2026-09-02", sent: 12 }, { day: "2026-09-03", sent: 0 }];
  const rects = barRects(quiet, 0, 0, 300, 100);
  assert.equal(rects.length, 3);
  for (const [i, r] of rects.entries()) assert.ok(r.h > 0, `bar ${i} has no height`);
  // The floor is the bar's own width, so the zero days read as dots on the baseline
  // rather than as nothing at all.
  assert.equal(rects[0].h, rects[0].w);
  assert.ok(rects[1].h > rects[0].h, "a busy day is still taller than a quiet one");
});

test("an all-zero month does not divide by zero", () => {
  const empty: DripDay[] = Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, sent: 0 }));
  assert.equal(barMax(empty), 1);
  for (const r of barRects(empty, 0, 0, 300, 100)) {
    assert.ok(Number.isFinite(r.h) && Number.isFinite(r.y), "NaN geometry from an empty month");
  }
});

test("the last bar is today's and is the only accented one", () => {
  const rects = barRects(SERIES, 26, 10, 400, 108);
  assert.equal(rects.filter((r) => r.today).length, 1);
  assert.equal(rects[rects.length - 1].today, true);
  assert.ok(rects[29].w > rects[28].w, "today's bar is the wider one");
});

test("the tallest bar reaches the top and nothing exceeds it", () => {
  const rects = barRects(SERIES, 0, 0, 400, 100);
  const max = barMax(SERIES);
  const tallest = rects[SERIES.findIndex((d) => d.sent === max)];
  assert.ok(Math.abs(tallest.h - 100) < 1e-9, `tallest bar is ${tallest.h}, not the full 100`);
  for (const r of rects) assert.ok(r.h <= 100 + 1e-9, "a bar exceeds the plot height");
});

test("empty input draws nothing rather than throwing", () => {
  assert.deepEqual(barRects([], 0, 0, 400, 100), []);
  assert.deepEqual(barMetrics(0, 400), { barWidth: 0, gap: 0 });
});

test("Mondays are the dated ticks, and the label has no leading zero", () => {
  assert.equal(isMonday("2026-09-07"), true);
  assert.equal(isMonday("2026-09-08"), false);
  assert.equal(mondayLabel("2026-09-07"), "Mon 7");
  assert.equal(mondayLabel("2026-09-14"), "Mon 14");
  assert.equal(isMonday("2026-08-17"), true);
  const mondays = SERIES.filter((d) => isMonday(d.day));
  assert.ok(mondays.length >= 4 && mondays.length <= 5, `${mondays.length} Mondays in 30 days`);
});

test("the day is parsed in UTC, never in the viewer's timezone", () => {
  // FOUND BY A SURVIVING MUTANT. Swapping getUTCDay for getDay leaves this suite green on
  // this machine and only on this machine: it sits at UTC+5:30, where the offset never
  // pushes 2026-09-07T00:00:00Z back across a day boundary. West of Greenwich it does,
  // and every Monday label lands on the wrong bar for that viewer.
  //
  // So the timezone is FORCED rather than trusted. A test whose result depends on where
  // the machine happens to be is not testing the property, it is testing the machine.
  const probe = (tz: string) =>
    execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { isMonday } from ${JSON.stringify(new URL("./charts.ts", import.meta.url).href)};` +
      `process.stdout.write(String(isMonday("2026-09-07")));`],
      { env: { ...process.env, TZ: tz }, encoding: "utf8" }).trim();
  for (const tz of ["UTC", "Pacific/Niue", "Pacific/Kiritimati", "America/Los_Angeles", "Asia/Kolkata"]) {
    assert.equal(probe(tz), "true", `2026-09-07 is a Monday in UTC but isMonday said otherwise under TZ=${tz}`);
  }
});

test("the mean line comes from the counter's own window, not from the series", () => {
  // Re-deriving it here is how the chart and the figure beside it start disagreeing by
  // a day, because the two windows are computed together server-side.
  assert.equal(sevenDayMean(PROD.drips.last7d), PROD.drips.last7d / 7);
  assert.equal(sevenDayMean(74), 74 / 7);
  assert.equal(sevenDayMean(null), null, "no window, no line");
  assert.equal(sevenDayMean(undefined), null);
});

/* ── the reserve scale ────────────────────────────────────────────────── */

test("the log scale puts the marks where they can be told apart", () => {
  assert.equal(logPosition(1), 0);
  // The whole reason for a log scale: on a linear one against a 10k ceiling, 500 and
  // 1000 sit at 5% and 10% and every interesting number is crushed into the left edge.
  const low = logPosition(500), target = logPosition(1000);
  assert.ok(target > low, "the target must sit right of the low mark");
  assert.ok(low > 0.6, `the low mark is at ${low}, crushed into the left`);
  assert.ok(target < 1, "the target is inside the bar");
  assert.ok(logPosition(10_000) < 1, "the 10k tick is inside the right edge, not pinned to it");
});

test("the scale clamps rather than overflowing at either end", () => {
  assert.equal(logPosition(0), 0);
  assert.equal(logPosition(-5), 0, "a negative balance sits at the origin, not off the left");
  assert.equal(logPosition(1e9), 1, "a balance above the scale fills the bar, it does not overflow");
  for (const v of [0, 1, 500, 1000, 10_000, 1e9]) {
    const p = logPosition(v);
    assert.ok(p >= 0 && p <= 1, `${v} maps to ${p}, outside the bar`);
  }
});

test("tick labels", () => {
  assert.deepEqual(RESERVE_TICKS.map(tickLabel), ["1", "10", "100", "1k", "10k"]);
});

test("the target label steps out of the balance label's way", () => {
  // THE OWNER'S RULING, as a decision rather than as a screenshot: these labels never
  // collide. On a log scale they nearly always want to, because a healthy balance puts
  // the target mark under the right-aligned balance label.
  //
  // Production's case: a 1000 target at ~70% of a 400px bar, with "4,507 TAZ" pinned
  // right. Beside the mark it would run into the balance, so it takes its own row.
  assert.equal(
    reserveTargetPlacement({ targetMarkX: 280, targetLabelWidth: 60, balanceLabelWidth: 56, right: 400 }),
    "own-row",
  );
  // Room to spare: a small target early on the scale stays beside its own mark, which
  // is where it belongs when it fits.
  assert.equal(
    reserveTargetPlacement({ targetMarkX: 100, targetLabelWidth: 50, balanceLabelWidth: 56, right: 400 }),
    "beside-mark",
  );
});

test("the collision rule is decided on measured widths, not on a guessed breakpoint", () => {
  // Walk the target mark across the bar and find where the decision flips. It must flip
  // exactly once, and exactly where the label would touch the balance's clearance.
  const balanceLabelWidth = 56, targetLabelWidth = 60, right = 400;
  const flips: number[] = [];
  let previous = reserveTargetPlacement({ targetMarkX: 0, targetLabelWidth, balanceLabelWidth, right });
  for (let x = 1; x <= right; x++) {
    const now = reserveTargetPlacement({ targetMarkX: x, targetLabelWidth, balanceLabelWidth, right });
    if (now !== previous) flips.push(x);
    previous = now;
  }
  assert.equal(flips.length, 1, `the decision flips ${flips.length} times, so it is not monotonic`);
  // right - balanceWidth - 8 clearance - 4 gap - targetWidth = 400 - 56 - 8 - 4 - 60
  assert.equal(flips[0], 273);
  // And a wider balance label pushes the flip earlier, which is the property that makes
  // this a measurement rather than a constant.
  const wider = reserveTargetPlacement({ targetMarkX: 272, targetLabelWidth, balanceLabelWidth: 90, right });
  assert.equal(wider, "own-row");
});

/* ── the stacked bars ─────────────────────────────────────────────────── */

test("segments are proportional and fill the track", () => {
  const rects = segmentRects([{ value: 40, token: "--orange" }, { value: 29, token: "--bar-soft" }], 690);
  assert.equal(rects.length, 2);
  assert.equal(rects[0].x, 0);
  // 40/69 of 690 = 400, less the 1.5px hairline.
  assert.ok(Math.abs(rects[0].w - 398.5) < 1e-9, `first segment is ${rects[0].w}`);
  assert.ok(Math.abs(rects[1].x - 400) < 1e-9, "the second segment starts where the first ends");
});

test("a zero segment is omitted rather than drawn as a sliver", () => {
  // A 1px line of "failed" beside 40 accepted reads as a failure that did not happen.
  // The legend beside the bar carries the zero, which is where a zero belongs.
  const rects = segmentRects(
    [{ value: 9, token: "--green" }, { value: 0, token: "--bad" }, { value: 0, token: "--unknown" }, { value: 1, token: "--warn" }],
    400,
  );
  assert.equal(rects.length, 2);
  assert.deepEqual(rects.map((r) => r.token), ["--green", "--warn"]);
});

test("an all-zero bar draws nothing at all", () => {
  // Production's sends card today: nothing decided in fifteen minutes. A full bar of any
  // colour would be a claim about traffic there has not been.
  const sends = PROD.sends;
  assert.equal(sends.ok + sends.failed + sends.unknown + sends.refused, 0);
  assert.deepEqual(
    segmentRects(
      [{ value: sends.ok, token: "--green" }, { value: sends.failed, token: "--bad" }, { value: sends.unknown, token: "--unknown" }, { value: sends.refused, token: "--warn" }],
      400,
    ),
    [],
  );
});

test("a negative count cannot eat the bar", () => {
  const rects = segmentRects([{ value: -5, token: "--bad" }, { value: 10, token: "--green" }], 400);
  assert.equal(rects.length, 1);
  assert.equal(rects[0].token, "--green");
  assert.ok(rects[0].w <= 400);
});

test("production's miner split is 40 accepted to 29 rejected", () => {
  const rects = segmentRects(
    [{ value: PROD.miner.submittedAccepted, token: "--orange" }, { value: PROD.miner.submittedRejected, token: "--bar-soft" }],
    600,
  );
  assert.equal(rects.length, 2);
  const total = PROD.miner.submittedAccepted + PROD.miner.submittedRejected;
  assert.ok(Math.abs(rects[0].w + 1.5 - (PROD.miner.submittedAccepted / total) * 600) < 1e-9);
});
