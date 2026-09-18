/**
 * The geometry behind the analytics canvases.
 *
 * WHY THE SHAPES ARE PURE FUNCTIONS AND THE DRAWING IS NOT. A canvas check can only ever
 * say "something was painted". It cannot say that two labels missed each other, that a
 * quiet day is still visible, or that the last bar is today's - and those are the
 * properties the owner actually ruled on. So every decision with a right answer lives
 * here, returning numbers, and the draw functions in this file consume them and do
 * nothing else. The tests then assert the decisions rather than the pixels.
 *
 * Ported from the approved preview (redesign-frozen/S2-S5-20260915T2110Z, the `charts`
 * block). The constants are the preview's and are not re-derived: 0.3 for the gap, the
 * log divisor of 4.3, the minimum bar height, the 8px and 4px label paddings. Where a
 * value here disagrees with the preview, one of the two is a typo.
 */

/** One UTC day of the series, as /api/status sends it. */
export interface DripDay {
  day: string;
  sent: number;
}

/* ── the daily bars ───────────────────────────────────────────────────── */

export interface BarRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The last bar is today's and is drawn accented and slightly wider. */
  today: boolean;
  /**
   * The day is BEFORE the counter's first record (#677), so `h` is 0 and the renderer draws
   * nothing. Not the same as a day that served none - that one keeps its minimum bar, and the
   * two are opposite news.
   */
  uncounted: boolean;
}

/**
 * Bar width and the gap between bars.
 *
 * The gap is 30% of a slot rather than a fixed pixel count, so thirty bars at 400px and
 * thirty bars at 900px read as the same chart. A minimum of 1px keeps the bars from
 * fusing into a solid block at the narrow end.
 */
export function barMetrics(count: number, innerWidth: number): { barWidth: number; gap: number } {
  if (count <= 0) return { barWidth: 0, gap: 0 };
  const gap = Math.max(1, (innerWidth / count) * 0.3);
  return { barWidth: (innerWidth - gap * (count - 1)) / count, gap };
}

/**
 * Where every bar goes.
 *
 * A DAY WITH NO DRIPS IS STILL DRAWN, at a height equal to the bar's width, which is the
 * dot visible along the baseline of the chart. This is the rule that makes the series
 * honest: thirty days with a gap in the middle would otherwise be indistinguishable from
 * a series that simply has no entry for that day, and the counter behind it deliberately
 * zero-fills so that quiet days are countable. Dropping them here would throw that away
 * one layer above where it was paid for.
 *
 * AND THERE IS A THIRD STATE THE RULE ABOVE DID NOT CONTEMPLATE (#677). `countedFrom` is
 * the first day the counter has any record of - `countingSince`, added by #675. A day
 * BEFORE it is not a quiet day; it is a day nobody counted, and the zero-fill was
 * plotting it as "served none". The two are opposite news and the chart drew them the
 * same mark.
 * So: inside the counted window the rule above is unchanged and a quiet day still gets
 * its minimum bar. Before it, the rect is marked `uncounted` and the renderers draw
 * NOTHING. That does not re-open the ambiguity the rule closes - a gap there cannot be
 * read as "no entry", because which days are uncounted is DERIVED from countedFrom
 * rather than inferred from a missing row.
 * Omit `countedFrom` and every day counts, which is what every existing caller means.
 *
 * The scale's top is the busiest day, never a fixed ceiling, and never zero: an all-zero
 * month divides by 1 instead of producing NaN geometry.
 */
export function barRects(series: readonly DripDay[], left: number, top: number, innerWidth: number, innerHeight: number, countedFrom?: string | null): BarRect[] {
  const n = series.length;
  if (n === 0) return [];
  const max = barMax(series, countedFrom);
  const { barWidth, gap } = barMetrics(n, innerWidth);
  return series.map((d, i) => {
    const uncounted = isUncounted(d.day, countedFrom);
    const h = uncounted ? 0 : Math.max(barWidth, (d.sent / max) * innerHeight);
    const today = i === n - 1;
    return {
      // Today's bar is 10% wider and centred on its slot, so the accent reads as
      // emphasis rather than as a taller neighbour.
      x: left + i * (barWidth + gap) - (today ? barWidth * 0.05 : 0),
      y: top + innerHeight - h,
      w: today ? barWidth * 1.1 : barWidth,
      h,
      today,
      uncounted,
    };
  });
}

/**
 * Is this day before the counter had any record at all?
 *
 * String comparison, deliberately: both sides are `YYYY-MM-DD` UTC, which sorts
 * lexicographically, and parsing them into Dates would introduce a timezone where there is
 * not one. No countedFrom means every day counts.
 */
export function isUncounted(day: string, countedFrom?: string | null): boolean {
  return !!countedFrom && day < countedFrom;
}

/**
 * The busiest day in the series, which is the axis's top label.
 *
 * UNCOUNTED DAYS ARE EXCLUDED, because their `sent` is a zero-fill rather than a
 * measurement - including them cannot change the max today (0 never wins) but it would the
 * moment the fill stopped being zero, and the axis label would then be scaled by a number
 * nobody counted.
 */
export function barMax(series: readonly DripDay[], countedFrom?: string | null): number {
  return Math.max(1, ...series.filter((d) => !isUncounted(d.day, countedFrom)).map((d) => d.sent));
}

/** Mondays carry a dated tick, every other day carries a short one. */
export function isMonday(day: string): boolean {
  return new Date(day + "T00:00:00Z").getUTCDay() === 1;
}

/** "Mon 7" from "2026-09-07", with no leading zero. */
export function mondayLabel(day: string): string {
  return "Mon " + day.slice(8).replace(/^0/, "");
}

/**
 * The 7-day mean, which the dashed line marks.
 *
 * Taken from the counter's own `last7d` rather than summed off the series, because the
 * two windows are computed together server-side against the same final day. Re-deriving
 * it here from a possibly shorter series is how a chart and the figure beside it start
 * disagreeing by one day.
 */
export function sevenDayMean(last7d: number | null | undefined): number | null {
  if (last7d == null) return null;
  return last7d / 7;
}

/* ── the reserve bar ──────────────────────────────────────────────────── */

/**
 * Position on the reserve's log scale, 0 to 1.
 *
 * LOG, NOT LINEAR, because the marks that matter sit three orders of magnitude apart: a
 * low mark of 500 against a balance that can reach five figures puts every interesting
 * number in the leftmost 5% of a linear bar. The divisor 4.3 places the 10k tick just
 * inside the right edge, so a healthy balance is not pinned to the end.
 *
 * Clamped at both ends: a balance above the scale fills the bar rather than overflowing
 * it, and anything under 1 sits at the origin instead of going negative.
 */
export function logPosition(value: number): number {
  return Math.min(1, Math.log10(Math.max(1, value)) / 4.3);
}

export const RESERVE_TICKS = [1, 10, 100, 1000, 10000] as const;

/** "1", "10", "100", "1k", "10k". */
export function tickLabel(v: number): string {
  return v >= 1000 ? v / 1000 + "k" : String(v);
}

/**
 * Whether the target label can sit beside its mark, or has to take its own row.
 *
 * THE OWNER RULED THAT THESE LABELS NEVER COLLIDE, and on a log scale they very nearly
 * always want to: 500 and 1000 are about 4% of the bar apart, and the balance label is
 * pinned to the right edge where the target mark also lands once the wallet is healthy.
 *
 * So the rule is positional rather than cosmetic, and it is decided here on measured
 * text widths rather than guessed at with a breakpoint. If the target label, drawn from
 * its mark, would reach into the balance label's 8px of clearance, both labels
 * right-align and the target takes the row above the balance. Otherwise the target sits
 * beside its own mark, which is where it belongs when there is room.
 *
 * Returns the placement so a test can drive the case directly: two widths and two
 * positions, no canvas, no screenshot.
 */
export function reserveTargetPlacement(args: {
  targetMarkX: number;
  targetLabelWidth: number;
  balanceLabelWidth: number;
  right: number;
}): "beside-mark" | "own-row" {
  const balanceLeft = args.right - args.balanceLabelWidth - 8;
  return args.targetMarkX + 4 + args.targetLabelWidth > balanceLeft ? "own-row" : "beside-mark";
}

/* ── the stacked bars (miner, sends) ──────────────────────────────────── */

export interface Segment {
  value: number;
  /** A CSS custom property name, resolved against the live theme when drawn. */
  token: string;
}

export interface SegmentRect {
  x: number;
  w: number;
  token: string;
}

/**
 * Widths for a stacked proportion bar.
 *
 * A ZERO SEGMENT IS OMITTED RATHER THAN DRAWN AT ZERO WIDTH, because a 1px sliver of
 * "failed" beside 40 accepted reads as a failure that did not happen. The legend beside
 * the bar carries every count including the zeroes, which is where a zero belongs.
 *
 * AN ALL-ZERO BAR DRAWS NOTHING and leaves the track empty. That is today's sends card:
 * nothing has been decided in fifteen minutes, and a full bar of any colour would be a
 * claim about traffic there has not been.
 */
export function segmentRects(segments: readonly Segment[], width: number): SegmentRect[] {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) return [];
  const out: SegmentRect[] = [];
  let x = 0;
  for (const s of segments) {
    const v = Math.max(0, s.value);
    if (v === 0) continue;
    const w = (v / total) * width;
    // 1.5px of hairline between segments, but never thinner than 1px of colour.
    out.push({ x, w: Math.max(w - 1.5, 1), token: s.token });
    x += w;
  }
  return out;
}

/* ── drawing ──────────────────────────────────────────────────────────── */

/** Resolve a theme token against the live document. */
function token(el: HTMLElement, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || "#888";
}

/** Size the backing store for the display's pixel ratio and return a clean context. */
export function prepareCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): CanvasRenderingContext2D | null {
  const ratio = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  canvas.width = Math.max(1, Math.round(cssWidth * ratio));
  canvas.height = Math.max(1, Math.round(cssHeight * ratio));
  canvas.style.height = cssHeight + "px";
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return ctx;
}

/** A rounded rectangle, clamped so the radius can never exceed the box. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export interface DripsChartInput {
  series: readonly DripDay[];
  last7d: number | null | undefined;
  /** First day the counter has any record of (#675's `countingSince`). Days before it are
   *  drawn as nothing rather than as a served-none bar - see barRects. */
  countedFrom?: string | null;
}

/** The thirty-day bar chart. Geometry from barRects, nothing decided here. */
/**
 * ONE OWNER FOR THE DRIPS PLOT BOX (#594). The hover hit-test has to agree with the paint or the
 * tooltip names a different day than the bar it lights, and the disagreement is invisible until
 * someone compares them by eye. Two copies of L/B/T drift the first time a margin moves, which is
 * the untied-constant shape with numbers instead of strings. `drawDrips` and `dripHitAtX` both
 * read this and nothing else knows the margins.
 */
export function dripsLayout(width: number): { height: number; L: number; B: number; T: number; iw: number; ih: number } {
  const height = 140;
  const L = 26, B = 22, T = 10;
  return { height, L, B, T, iw: width - L - 4, ih: height - T - B };
}

/**
 * Which bar a pointer at `clientX` is over, with the anchor the tooltip hangs from, or null when
 * the pointer is outside the plot. NEAREST CENTRE rather than strict containment: the gaps
 * between bars are dead space a reader does not perceive as "off the chart", and a tooltip that
 * blinks out between bars reads as a bug rather than as precision.
 */
export function dripHitAtX(
  canvas: HTMLCanvasElement,
  series: readonly DripDay[],
  clientX: number,
): { index: number; cx: number; top: number } | null {
  const box = canvas.getBoundingClientRect();
  const width = box.width || 400;
  const { L, T, iw, ih } = dripsLayout(width);
  const rects = barRects(series, L, T, iw, ih);
  if (rects.length === 0) return null;
  const x = clientX - box.left;
  if (x < L || x > L + iw) return null;
  let best = 0, bestD = Infinity;
  for (const [i, r] of rects.entries()) {
    const d = Math.abs(x - (r.x + r.w / 2));
    if (d < bestD) { bestD = d; best = i; }
  }
  const r = rects[best];
  return { index: best, cx: r.x + r.w / 2, top: r.y };
}

export function drawDrips(canvas: HTMLCanvasElement, host: HTMLElement, input: DripsChartInput, hovered: number): void {
  const width = canvas.getBoundingClientRect().width || 400;
  const { height, L, T, iw, ih } = dripsLayout(width);
  const ctx = prepareCanvas(canvas, width, height);
  if (!ctx) return;
  const rects = barRects(input.series, L, T, iw, ih, input.countedFrom);
  const max = barMax(input.series, input.countedFrom);

  for (const [i, r] of rects.entries()) {
    // NOTHING IS DRAWN FOR A DAY NOBODY COUNTED (#677). A served-none day keeps its minimum
    // bar; this one gets no mark at all, because "we have no record" and "none went out" are
    // opposite news and the chart drew them identically until now.
    if (r.uncounted) continue;
    if (r.today) {
      ctx.save();
      ctx.shadowColor = "rgba(255,105,0,.28)";
      ctx.shadowBlur = Math.max(3, iw * 0.012);
      ctx.fillStyle = token(host, "--orange");
      roundRect(ctx, r.x, r.y, r.w, r.h, r.w);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = i === hovered ? token(host, "--orange-line") : token(host, "--bar-soft");
      roundRect(ctx, r.x, r.y, r.w, r.h, r.w);
      ctx.fill();
    }
  }

  ctx.font = "10px " + token(host, "--mono");
  ctx.fillStyle = token(host, "--label");
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const v of [0, max]) ctx.fillText(String(v), L - 6, T + ih - (v / max) * ih);

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const { barWidth, gap } = barMetrics(input.series.length, iw);
  input.series.forEach((d, i) => {
    const cx = L + i * (barWidth + gap) + barWidth / 2;
    ctx.fillStyle = token(host, "--label");
    if (isMonday(d.day)) {
      ctx.fillRect(cx - 0.5, T + ih + 3, 1, 4);
      ctx.fillText(mondayLabel(d.day), cx, T + ih + 9);
    } else {
      ctx.fillRect(cx - 0.5, T + ih + 3, 1, 2);
    }
  });

  const mean = sevenDayMean(input.last7d);
  if (mean !== null) {
    const my = T + ih - (mean / max) * ih;
    ctx.strokeStyle = token(host, "--muted");
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(L, my + 0.5);
    ctx.lineTo(width - 4, my + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = token(host, "--muted");
    ctx.fillText("7-day mean " + mean.toFixed(1), width - 6, my - 2);
  }
}

export interface ReserveInput {
  spendableTaz: number | null;
  lowTaz: number | null;
  targetTaz: number | null;
  refilling: boolean;
  balanceLabel: string;
}

/**
 * The reserve bar, full size or the miniature on the status card.
 *
 * The miniature carries the track, the fill and the ticks only. Every label is dropped
 * rather than shrunk: the collision rule below needs room to resolve, and a label that
 * has nowhere to step to is how two of them end up on top of each other.
 */
export function drawReserve(canvas: HTMLCanvasElement, host: HTMLElement, input: ReserveInput, mini: boolean): void {
  const width = canvas.getBoundingClientRect().width || 400;
  const height = mini ? 46 : 92;
  const ctx = prepareCanvas(canvas, width, height);
  if (!ctx) return;
  const L = 2, iw = width - 4, y = mini ? 14 : 30, bh = mini ? 10 : 14;

  ctx.fillStyle = token(host, "--bar-soft");
  roundRect(ctx, L, y, iw, bh, bh / 2);
  ctx.fill();

  // A null balance fills nothing. An empty track beside a "balance unknown" label is the
  // honest picture; a full bar would say the wallet is fine and a zero bar would say it
  // is empty, and we know neither.
  const fill = input.spendableTaz == null ? 0 : logPosition(input.spendableTaz) * iw;
  if (fill > 0) {
    ctx.fillStyle = token(host, "--orange");
    roundRect(ctx, L, y, fill, bh, bh / 2);
    ctx.fill();
  }

  if (input.refilling && input.targetTaz != null) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(L + fill, y, Math.min(iw - fill, logPosition(input.targetTaz * 3) * iw), bh);
    ctx.clip();
    ctx.strokeStyle = token(host, "--orange-line");
    ctx.lineWidth = 2;
    for (let i = -bh; i < iw; i += 7) {
      ctx.beginPath();
      ctx.moveTo(L + fill + i, y + bh);
      ctx.lineTo(L + fill + i + bh, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.font = (mini ? 9 : 10) + "px " + token(host, "--mono");
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = token(host, "--label");
  for (const v of RESERVE_TICKS) {
    const tx = L + logPosition(v) * iw;
    ctx.fillRect(tx - 0.5, y + bh + 2, 1, 3);
    ctx.fillText(tickLabel(v), tx, y + bh + 6);
  }

  for (const [value, tok] of [[input.lowTaz, "--bad"], [input.targetTaz, "--warn"]] as const) {
    if (value == null) continue;
    const tx = L + logPosition(value) * iw;
    ctx.fillStyle = token(host, tok);
    ctx.fillRect(tx - 0.75, y - (mini ? 4 : 8), 1.5, bh + (mini ? 4 : 8) + (mini ? 0 : 4));
  }

  if (mini) return;

  ctx.fillStyle = token(host, "--muted");
  ctx.textBaseline = "bottom";
  ctx.textAlign = "right";
  ctx.fillText(input.balanceLabel, L + iw, y - 3);

  if (input.targetTaz != null) {
    const targetLabel = "target " + input.targetTaz;
    const placement = reserveTargetPlacement({
      targetMarkX: L + logPosition(input.targetTaz) * iw,
      targetLabelWidth: ctx.measureText(targetLabel).width,
      balanceLabelWidth: ctx.measureText(input.balanceLabel).width,
      right: L + iw,
    });
    if (placement === "own-row") {
      ctx.textAlign = "right";
      ctx.fillText(targetLabel, L + iw, y - 14);
    } else {
      ctx.textAlign = "left";
      ctx.fillText(targetLabel, L + logPosition(input.targetTaz) * iw + 4, y - 3);
    }
  }

  if (input.lowTaz != null) {
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    ctx.fillText("low " + input.lowTaz, L + logPosition(input.lowTaz) * iw, y + bh + 19);
  }
}

/** A stacked proportion bar with a rounded track. Used by the miner and sends cards. */
export function drawSegments(canvas: HTMLCanvasElement, host: HTMLElement, segments: readonly Segment[]): void {
  const width = canvas.getBoundingClientRect().width || 400;
  const ctx = prepareCanvas(canvas, width, 34);
  if (!ctx) return;
  ctx.fillStyle = token(host, "--bar-soft");
  roundRect(ctx, 0, 10, width, 14, 7);
  ctx.fill();
  ctx.save();
  roundRect(ctx, 0, 10, width, 14, 7);
  ctx.clip();
  for (const r of segmentRects(segments, width)) {
    ctx.fillStyle = token(host, r.token);
    ctx.fillRect(r.x, 10, r.w, 14);
  }
  ctx.restore();
}
