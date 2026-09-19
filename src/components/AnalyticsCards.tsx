/**
 * The Analytics view: four canvases and the network card, transcribed from the approved
 * preview (redesign-frozen/S2-S5-20260915T2110Z, the `data-view="analytics"` section).
 *
 * COUNTS ONLY, AND COUNTS BY UTC DAY. There is nothing per user here and nothing here
 * for per-user data to grow into, because the table behind the series holds (network,
 * day, sent) and no claim row ever reaches it. That is a property of the ledger, not a
 * decision this view makes, and the view's job is to not quietly want more than that.
 *
 * EVERY CANVAS CARRIES A TEXT SUMMARY as its accessible name, rebuilt from the same
 * numbers it drew. A chart that is only a picture is not a readout for a screen reader,
 * and the alternative usually shipped - an alt of "chart" - is worse than nothing
 * because it announces that something is being withheld.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { drawDrips, dripHitAtX, drawReserve, drawSegments, barMax, isUncounted, sevenDayMean, type DripDay, type Segment } from "@/lib/charts";
import { paintGlyph, type GlyphName } from "@/lib/glyphs";
import { groupDigits, reserveSentence, reserveWord, reserveChipTone, acceptSentence, minerWord, minerTone, syncFigure, heightDiff, heightNote, backendHost } from "@/lib/statusView";
import type { Tone, ViewStatus } from "./viewStatus";

/**
 * Repaint on the three things that change a canvas and do not fire a render.
 *
 * A width change (this grid goes three columns to one), a theme change (an attribute on
 * <html>, no event), and new data. Missing any one of them leaves a chart that is
 * correct at first paint and silently wrong afterwards, which is the failure mode a
 * screenshot test is least likely to catch because the first shot is always right.
 */
function useCanvasPainter(paint: () => void, signature: string) {
  const ref = useRef<HTMLCanvasElement>(null);
  // The observers are wired once per data change, but they must call the CURRENT paint,
  // not the one captured when they were attached. A resize that repaints last poll's
  // numbers is the kind of staleness that looks like a live chart and is not one.
  const latest = useRef(paint);
  useEffect(() => {
    latest.current = paint;
  });
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const run = () => latest.current();
    run();
    const ro = new ResizeObserver(run);
    ro.observe(canvas);
    const mo = new MutationObserver(run);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [signature]);
  return ref;
}

function Tag({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className="tag word" data-tone={tone}>
      {children}
    </span>
  );
}

/**
 * A figure the page shows ONLY when it has one. Owner's rule, 2026-09-19: nothing on the
 * page says "unknown".
 *
 * THE TRAP IN THAT RULE IS `?? 0`, and this codebase has already fallen into it four times
 * in one week - "100% accepted by our node" from a null refused count, a screen reader
 * hearing "0 counted" where the page drew a dash, a day nobody counted plotted as a day
 * that served none. Deleting the word "unknown" by writing a zero replaces an ugly truth
 * with a confident lie.
 *
 * So there is a third option and it is the only honest one: SAY NOTHING. An omitted figure
 * makes no claim. The label goes with it, because a label with no number is just the word
 * "unknown" spelled differently.
 *
 * Structural rather than remembered (L53): a caller hands over `string | null` and cannot
 * render the null case even by accident, so the next figure added here inherits the rule
 * without anyone recalling that it exists.
 */
function Figs({ items, big }: { items: { label: string; value: string | null; note?: React.ReactNode }[]; big?: string }) {
  const known = items.filter((i) => i.value !== null);
  // Every figure absent is itself worth saying - an empty row under a heading reads as a
  // rendering fault. Plain words, because "unknown" is the thing being removed.
  if (known.length === 0) return <p className="sent">Not being reported right now.</p>;
  return (
    <div className="figs">
      {known.map((i) => (
        <span key={i.label} className={i.label === big ? "big" : undefined}>
          {i.label}<b>{i.value}</b>{i.note}
        </span>
      ))}
    </div>
  );
}

/** The same rule for a prose fragment: absent contributes nothing rather than the word. */
function said(parts: (string | null)[]): string {
  return parts.filter((p): p is string => p !== null).join(", ");
}

export function AnalyticsCards({ status }: { status: ViewStatus | null }) {
  const drips = status?.drips ?? null;
  const series: DripDay[] = drips?.byDay ?? [];
  const reserve = status?.reserve;
  const miner = status?.miner;
  const unit = status?.box?.minerUnit ?? null;
  const node = status?.node;

  // THE HOVER THE DESIGN DRAWS (#594). `drawDrips` already lit `i === hovered` with --orange-line
  // and was called with a literal -1, so the highlight shipped and could never fire. The index
  // goes into the painter's key as well as its argument: without it the repaint is skipped and
  // the bar under the pointer never changes colour, which looks exactly like a chart with no
  // hover at all - the failure this issue is about, one layer along.
  const [hover, setHover] = useState<{ index: number; cx: number; top: number } | null>(null);

  const dripsRef = useCanvasPainter(() => {
    const c = dripsRef.current;
    if (c) drawDrips(c, c, { series, last7d: drips?.last7d, countedFrom: drips?.countingSince }, hover?.index ?? -1);
  }, `${series.length}:${series.map((d) => d.sent).join(",")}:${drips?.last7d}:${drips?.countingSince}:${hover?.index ?? -1}`);

  const reserveRef = useCanvasPainter(() => {
    const c = reserveRef.current;
    if (c)
      drawReserve(
        c,
        c,
        {
          spendableTaz: reserve?.spendableTaz ?? null,
          lowTaz: reserve?.lowTaz ?? null,
          targetTaz: reserve?.targetTaz ?? null,
          refilling: reserve?.refilling ?? false,
          balanceLabel: reserve?.spendableTaz == null ? "balance unknown" : `${groupDigits(Math.round(reserve.spendableTaz))} TAZ`,
        },
        false,
      );
  }, `${reserve?.spendableTaz}:${reserve?.lowTaz}:${reserve?.targetTaz}:${reserve?.refilling}`);

  const minerSegments: Segment[] = [
    { value: miner?.submittedAccepted ?? 0, token: "--orange" },
    { value: miner?.submittedRejected ?? 0, token: "--bar-soft" },
  ];
  const minerRef = useCanvasPainter(() => {
    const c = minerRef.current;
    if (c) drawSegments(c, c, minerSegments);
  }, `${miner?.submittedAccepted}:${miner?.submittedRejected}`);

  const mean = sevenDayMean(drips?.last7d);
  const today = series.length ? series[series.length - 1].sent : null;
  // How much of the window predates the counter, so the label can say it rather than leaving a
  // silent gap for a screen reader.
  const uncountedDays = series.filter((d) => isUncounted(d.day, drips?.countingSince)).length;
  const diff = heightDiff(node?.nodeHeight, node?.externalHeight);
  const sync = syncFigure(node?.syncPercent, node?.ready ?? false);
  const host = backendHost(status?.backend?.endpoint);

  return (
    <div className="pcards">
      <div className="pc">
        <h3>
          <Glyph name="drips" />
          Drips per day, 30 days
        </h3>
        <div className="chart">
          <canvas
            ref={dripsRef}
            id="c-drips"
            height={140}
            role="img"
            onPointerMove={(e) => {
              const c = dripsRef.current;
              if (c) setHover(dripHitAtX(c, series, e.clientX));
            }}
            onPointerLeave={() => setHover(null)}
            /* The summary is built from the numbers that were drawn, so it cannot drift
               away from the picture. An empty series says so rather than reading as a
               month in which nobody claimed anything. */
            aria-label={
              series.length === 0
                ? "Drips per day for the last 30 days. The series is not available."
                : `Drips per day for the last 30 days. ${said([
                    drips?.last30d != null ? `${groupDigits(drips.last30d)} drips in 30 days` : null,
                    drips?.last7d != null ? `${groupDigits(drips.last7d)} this week` : null,
                    mean !== null ? `mean ${mean.toFixed(1)} per day over 7 days` : null,
                    // countingSince STAYS (#677, SDE-UI): the axis top must not be scaled by days
                    // nobody counted. Dropping it here was the collision, and no row would have
                    // noticed.
                    `busiest day ${barMax(series, drips?.countingSince)}`,
                    // `${today ?? 0} today` was a fourth invented zero, in the label rather than
                    // the chart, and it survived the sweep that fixed Sparkline's three.
                    // UI's version said "today unknown"; under the owner's instruction the right
                    // shape is to omit the clause, and they said so themselves rather than
                    // defending the wording they wrote before the instruction existed.
                    today != null ? `${today} today` : null,
                  ])}.${uncountedDays > 0 ? ` ${uncountedDays} of the 30 days are before counting began and are not plotted.` : ""}`
            }
          />
          {/* `hidden` rather than unmounting, because the design ships one `.tip` per chart and a
              node that comes and goes cannot be styled or found by a test at rest. Position is
              inline because it follows the pointer; everything about how it LOOKS is the sheet's,
              transcribed from S1's shell.css:287. */}
          <div
            className="tip"
            id="tip"
            data-testid="drips-tip"
            hidden={!hover}
            style={hover ? { left: `${hover.cx}px`, top: `${hover.top}px` } : undefined}
          >
            {hover
              ? isUncounted(series[hover.index]?.day ?? "", drips?.countingSince)
                // A day before the counter existed has no figure to show, and "0 on 12 Aug" is the
                // one thing it must not say (#677). Same rule as the bar it has no mark for.
                ? `not counted on ${series[hover.index]?.day ?? ""}`
                : `${series[hover.index]?.sent ?? 0} on ${series[hover.index]?.day ?? ""}`
              : ""}
          </div>
        </div>
        {/* "counted", not "all time" - see Shell.tsx. The figure begins when the counter
            shipped, not at genesis, and the label must not out-claim it. */}
        <div className="tot">
          <Figs items={[
            { label: "this week", value: drips?.last7d != null ? groupDigits(drips.last7d) : null },
            { label: "30 days", value: drips?.last30d != null ? groupDigits(drips.last30d) : null },
            {
              label: "counted",
              value: drips?.allTime != null ? groupDigits(drips.allTime) : null,
              // "counted", not "all time" - the figure begins when the counter shipped, not at
              // genesis. AND NOW IT SAYS SINCE WHEN (#675 put the date on the wire): "counted"
              // alone dropped the false claim without replacing it with the true one. A span and
              // no class of its own - `<i>` here is a swatch or a progress fill, never prose.
              // ui-smoke pins this testid, which is the one of SDE-UI's four that reds loudly if
              // a careless merge drops it. The other three would have gone silently.
              note: drips?.countingSince ? <span data-testid="counting-since">since {drips.countingSince}</span> : null,
            },
          ]} />
        </div>
      </div>

      <div className="pc">
        <h3>
          <Glyph name="reserve" />
          Wallet reserve
          {/* WORD FROM THE FACTS, TONE FROM THE WORD, which is the order index.html:932 and :881
              use. Deriving the word from the tone lost `refilling` entirely, because a tone has
              three values and the word needs four. */}
          <Tag tone={reserveChipTone(reserveWord(reserve))}>{reserveWord(reserve)}</Tag>
        </h3>
        <canvas
          ref={reserveRef}
          id="c-reserve"
          height={92}
          role="img"
          aria-label={
            reserve?.spendableTaz == null
              ? "Wallet reserve. The spendable balance is unknown right now."
              : `Wallet reserve. ${said([
                  `${groupDigits(Math.round(reserve.spendableTaz))} TAZ spendable`,
                  reserve.lowTaz != null ? `low mark ${groupDigits(reserve.lowTaz)}` : null,
                  reserve.targetTaz != null ? `target ${groupDigits(reserve.targetTaz)}` : null,
                ])}.${reserve.refilling ? " Topping up." : ""}`
          }
        />
        <p className="sent">{reserveSentence(reserve, status?.dripTaz ?? 0)}</p>
        <Figs big="spendable" items={[
          { label: "spendable", value: reserve?.spendableTaz != null ? groupDigits(Math.round(reserve.spendableTaz)) : null },
          { label: "low", value: reserve?.lowTaz != null ? groupDigits(reserve.lowTaz) : null },
          { label: "target", value: reserve?.targetTaz != null ? groupDigits(reserve.targetTaz) : null },
        ]} />
      </div>

      <div className="pc">
        <h3>
          <Glyph name="miner" />
          Miner
          <Tag tone={minerTone(miner, unit)}>{minerWord(miner, unit)}</Tag>
        </h3>
        <canvas
          ref={minerRef}
          id="c-miner"
          height={34}
          role="img"
          // ONE SOURCE, BECAUSE THIS LABEL USED TO CONTRADICT ITSELF IN A SINGLE BREATH. It
          // assembled the counts itself AND appended acceptSentence(), so on prod - accepted
          // 2172, rejected null - a screen reader heard "2172 accepted and unknown rejected by
          // our node, 100% accepted by our node": the unknown and the certainty in one sentence.
          // Each half was defensible alone, which is the L51 shape at the level of a label
          // rather than an assertion. The sentence already states both counts and handles
          // absent, so it is the only thing said here (SDE-App).
          aria-label={`Miner. ${acceptSentence(miner)}.`}
        />
        {/* THE REJECTED SWATCH GOES WITH ITS NUMBER. A legend key for a quantity we do not
            have is a coloured square next to nothing, and prod is exactly that case today:
            submittedRejected is null and has been since the counts were seeded. */}
        <div className="legend">
          {miner?.submittedAccepted != null && (
            <span>
              <i style={{ background: "var(--orange)" }} />
              accepted {groupDigits(miner.submittedAccepted)}
            </span>
          )}
          {miner?.submittedRejected != null && (
            <span>
              <i style={{ background: "var(--bar-soft)" }} />
              rejected {groupDigits(miner.submittedRejected)}
            </span>
          )}
        </div>
        <p className="sent">{acceptSentence(miner)}</p>
        <Figs items={[
          { label: "template age", value: miner?.templateAgoSeconds != null ? `${miner.templateAgoSeconds}s` : null },
          { label: "last beat", value: miner?.beatAgoSeconds != null ? `${miner.beatAgoSeconds}s` : null },
          { label: "solved", value: miner?.solvedCount != null ? groupDigits(miner.solvedCount) : null },
        ]} />
      </div>

      {/* THE SENDS CARD IS GONE (owner, 2026-09-19). It judged a 15-minute window and needed
          three completed sends to reach a verdict; prod serves about one drip every two hours,
          so the window essentially never fills and the card read "unknown" permanently. A health
          indicator that cannot reach a verdict is not one.
          THE MECHANISM STAYS AND IS NOT COSMETIC: /api/faucet still refuses claims when sends are
          degraded, /api/ready still reports sendsBlock, and `sends.state` still drives the page's
          degraded phase - so a genuinely failing wallet still says "Not taking claims right now"
          on the front page, which is where a visitor needs it. What was removed is a tile that
          reported the absence of a sample. */}

      <div className="pc wide">
        <h3>
          <Glyph name="network" />
          Network
        </h3>
        <div className="figs">
          {node?.nodeHeight != null && (
            <span className="big">
              our height<b>{groupDigits(node.nodeHeight)}</b>
            </span>
          )}
          {node?.externalHeight != null && (
            <span className="big">
              independent reference<b>{groupDigits(node.externalHeight)}</b>
            </span>
          )}
          {/* THE DIFFERENCE NEEDS BOTH HEIGHTS AND SAYS SO BY ABSENCE. `heightDiff` already
              returns null unless it has the pair, so this row disappears exactly when one of
              the two above it has - it cannot be left behind claiming a comparison it could
              not make. */}
          {diff !== null && (
            <span>
              difference<b>{`${diff >= 0 ? "+" : ""}${groupDigits(Math.abs(diff) * (diff < 0 ? -1 : 1))}`}</b>
              <span>{heightNote(diff)}</span>
            </span>
          )}
          {sync !== null && (
            <span>
              {/* The figure carries its own % and never wraps (owner ruling). */}
              sync<b>{sync}</b>
            </span>
          )}
          {/* THE DOT IS NOT A SUBSTITUTE FOR THE HOST. Without a host the row would be a
              label, a coloured dot and nothing else - a reachability claim about a backend
              we cannot name. Both go together. */}
          {host !== null && (
            <span>
              backend
              <b>
                <span className="rdot" data-on={String(Boolean(status?.backend?.reachable))} />
                {host}
              </b>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One card-title glyph. A canvas rather than an SVG because that is what the approved preview
 * uses, and because the glyph takes its COLOUR from its own computed style, so it follows the
 * theme without a prop and without a second palette to keep in step.
 *
 * REPAINTS ON THEME, like every other canvas in this view. A canvas keeps its pixels across a
 * theme switch, so an icon painted once stays the old ink colour on the new background - the
 * failure the other four canvases already have a painter for. `data-theme` moves on <html>, so
 * that is what is observed.
 */
function Glyph({ name }: { name: GlyphName }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const paint = () => paintGlyph(canvas, name);
    paint();
    const mo = new MutationObserver(paint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // Width drives the whole 16-grid scale, so a resize is a repaint as well as a re-layout.
    const ro = new ResizeObserver(paint);
    ro.observe(canvas);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [name]);
  return <canvas ref={ref} className="g" data-glyph={name} aria-hidden="true" />;
}

