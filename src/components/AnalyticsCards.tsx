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

import { useEffect, useRef } from "react";
import { drawDrips, drawReserve, drawSegments, barMax, sevenDayMean, type DripDay, type Segment } from "@/lib/charts";
import { paintGlyph, type GlyphName } from "@/lib/glyphs";
import { groupDigits, reserveSentence, reserveWord, reserveChipTone, acceptSentence, minerWord, minerTone, sendsTone, syncFigure, heightDiff, heightNote, backendHost } from "@/lib/statusView";
import type { Tone, ViewStatus } from "./viewStatus";
import { UNKNOWN } from "./viewStatus";

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

export function AnalyticsCards({ status }: { status: ViewStatus | null }) {
  const drips = status?.drips ?? null;
  const series: DripDay[] = drips?.byDay ?? [];
  const reserve = status?.reserve;
  const miner = status?.miner;
  const unit = status?.box?.minerUnit ?? null;
  const sends = status?.sends;
  const node = status?.node;

  const dripsRef = useCanvasPainter(() => {
    const c = dripsRef.current;
    if (c) drawDrips(c, c, { series, last7d: drips?.last7d }, -1);
  }, `${series.length}:${series.map((d) => d.sent).join(",")}:${drips?.last7d}`);

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

  const sendSegments: Segment[] = [
    { value: sends?.ok ?? 0, token: "--green" },
    { value: sends?.failed ?? 0, token: "--bad" },
    { value: sends?.unknown ?? 0, token: "--unknown" },
    { value: sends?.refused ?? 0, token: "--warn" },
  ];
  const sendsRef = useCanvasPainter(() => {
    const c = sendsRef.current;
    if (c) drawSegments(c, c, sendSegments);
  }, `${sends?.ok}:${sends?.failed}:${sends?.unknown}:${sends?.refused}`);

  const mean = sevenDayMean(drips?.last7d);
  const today = series.length ? series[series.length - 1].sent : null;
  const diff = heightDiff(node?.nodeHeight, node?.externalHeight);

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
            /* The summary is built from the numbers that were drawn, so it cannot drift
               away from the picture. An empty series says so rather than reading as a
               month in which nobody claimed anything. */
            aria-label={
              series.length === 0
                ? "Drips per day for the last 30 days. The series is not available."
                : `Drips per day for the last 30 days. ${drips?.last30d ?? UNKNOWN} drips in 30 days, ${drips?.last7d ?? UNKNOWN} this week, ` +
                  `${mean === null ? "no 7 day mean" : `mean ${mean.toFixed(1)} per day over 7 days`}, busiest day ${barMax(series)}. ${today ?? 0} today.`
            }
          />
        </div>
        <div className="tot">
          <span>
            this week<b>{drips?.last7d != null ? groupDigits(drips.last7d) : UNKNOWN}</b>
          </span>
          <span>
            30 days<b>{drips?.last30d != null ? groupDigits(drips.last30d) : UNKNOWN}</b>
          </span>
          <span>
            all time<b>{drips?.allTime != null ? groupDigits(drips.allTime) : UNKNOWN}</b>
          </span>
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
              : `Wallet reserve. ${groupDigits(Math.round(reserve.spendableTaz))} TAZ spendable against a low mark of ${reserve.lowTaz ?? UNKNOWN} ` +
                `and a target of ${reserve.targetTaz ?? UNKNOWN}.${reserve.refilling ? " Topping up." : ""}`
          }
        />
        <p className="sent">{reserveSentence(reserve, status?.dripTaz ?? 0)}</p>
        <div className="figs">
          <span className="big">
            spendable<b>{reserve?.spendableTaz != null ? groupDigits(Math.round(reserve.spendableTaz)) : UNKNOWN}</b>
          </span>
          <span>
            low<b>{reserve?.lowTaz != null ? groupDigits(reserve.lowTaz) : UNKNOWN}</b>
          </span>
          <span>
            target<b>{reserve?.targetTaz != null ? groupDigits(reserve.targetTaz) : UNKNOWN}</b>
          </span>
        </div>
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
          aria-label={`Miner. ${miner?.submittedAccepted ?? UNKNOWN} accepted and ${miner?.submittedRejected ?? UNKNOWN} rejected by our node, ${acceptSentence(miner)}.`}
        />
        <div className="legend">
          <span>
            <i style={{ background: "var(--orange)" }} />
            accepted {miner?.submittedAccepted ?? UNKNOWN}
          </span>
          <span>
            <i style={{ background: "var(--bar-soft)" }} />
            rejected {miner?.submittedRejected ?? UNKNOWN}
          </span>
        </div>
        <p className="sent">{acceptSentence(miner)}</p>
        <div className="figs">
          <span>
            template age<b>{miner?.templateAgoSeconds != null ? `${miner.templateAgoSeconds}s` : UNKNOWN}</b>
          </span>
          <span>
            last beat<b>{miner?.beatAgoSeconds != null ? `${miner.beatAgoSeconds}s` : UNKNOWN}</b>
          </span>
          <span>
            solved<b>{miner?.solvedCount != null ? groupDigits(miner.solvedCount) : UNKNOWN}</b>
          </span>
        </div>
      </div>

      <div className="pc">
        <h3>
          <Glyph name="sends" />
          Sends, last 15 min
          <Tag tone={sendsTone(sends?.state)}>{sends?.state ?? UNKNOWN}</Tag>
        </h3>
        <canvas
          ref={sendsRef}
          id="c-sends"
          height={34}
          role="img"
          aria-label={
            sends == null
              ? "Sends in the last 15 minutes. Not reported by this deploy."
              : `Sends in the last 15 minutes: ${sends.state}. ${sends.ok} ok, ${sends.failed} failed, ${sends.unknown} unknown, ${sends.refused ?? 0} refused. ${sends.reason}.`
          }
        />
        <div className="legend">
          <span>
            <i style={{ background: "var(--green)" }} />
            ok {sends?.ok ?? UNKNOWN}
          </span>
          <span>
            <i style={{ background: "var(--bad)" }} />
            failed {sends?.failed ?? UNKNOWN}
          </span>
          <span>
            <i style={{ background: "var(--unknown)" }} />
            unknown {sends?.unknown ?? UNKNOWN}
          </span>
          <span>
            <i style={{ background: "var(--warn)" }} />
            refused {sends?.refused ?? UNKNOWN}
          </span>
        </div>
        <p className="sent">{sends?.reason ?? "Not reported by this deploy."}</p>
      </div>

      <div className="pc wide">
        <h3>
          <Glyph name="network" />
          Network
        </h3>
        <div className="figs">
          <span className="big">
            our height<b>{node?.nodeHeight != null ? groupDigits(node.nodeHeight) : UNKNOWN}</b>
          </span>
          <span className="big">
            independent reference<b>{node?.externalHeight != null ? groupDigits(node.externalHeight) : UNKNOWN}</b>
          </span>
          <span>
            difference<b>{diff === null ? UNKNOWN : `${diff >= 0 ? "+" : ""}${groupDigits(Math.abs(diff) * (diff < 0 ? -1 : 1))}`}</b>
            <span>{heightNote(diff)}</span>
          </span>
          <span>
            {/* The figure carries its own % and never wraps (owner ruling). */}
            sync<b>{syncFigure(node?.syncPercent, node?.ready ?? false)}</b>
          </span>
          <span>
            backend
            <b>
              <span className="rdot" data-on={String(Boolean(status?.backend?.reachable))} />
              {backendHost(status?.backend?.endpoint)}
            </b>
          </span>
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

