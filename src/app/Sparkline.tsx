"use client";

import { useEffect, useRef } from "react";

/**
 * The series' shape, declared here rather than imported from `@/lib/db`. That module
 * pulls better-sqlite3, and while `import type` erases, the page already declares its own
 * view of the status body the same way: the client's contract is the JSON it receives,
 * not the server's internal type.
 */
export interface DripDay {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  sent: number;
}

/**
 * The header strip's thirty-day sparkline, ported from the preview's `bars`/`drawSpark`
 * (~/.claude/ipc/share/redesign/index.html). Counts only, which is all `drips.byDay`
 * carries: no address, no identity, nothing per-user (#549 shipped the series that way and
 * this draws exactly it).
 *
 * Canvas rather than SVG because the preview's is, and because thirty rounded bars redrawn
 * on every poll is cheaper as one paint than as thirty elements React has to reconcile.
 */

/** A CSS custom property's computed value, which is where the design's colours live. */
function tok(name: string, el: Element): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Device-pixel-ratio aware sizing. Without this the bars are soft on every retina screen. */
function prep(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const d = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(w * d));
  c.height = Math.max(1, Math.round(h * d));
  const x = c.getContext("2d");
  if (!x) return null;
  x.setTransform(d, 0, 0, d, 0, 0);
  x.clearRect(0, 0, w, h);
  return x;
}

/** A rounded rectangle path. The preview's `rr`, unchanged. */
function rr(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  R = Math.min(R, W / 2, H / 2);
  x.beginPath();
  x.moveTo(X + R, Y);
  x.arcTo(X + W, Y, X + W, Y + H, R);
  x.arcTo(X + W, Y + H, X, Y + H, R);
  x.arcTo(X, Y + H, X, Y, R);
  x.arcTo(X, Y, X + W, Y, R);
  x.closePath();
}

export function Sparkline({
  byDay,
  last7d,
  allTime,
  theme,
}: {
  byDay: DripDay[];
  last7d: number | null;
  allTime: number | null;
  theme: "paper" | "ink";
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c || byDay.length === 0) return;

    const draw = () => {
      const r = c.getBoundingClientRect();
      const w = r.width || 80;
      const h = r.height || 22;
      const x = prep(c, w, h);
      if (!x) return;

      // The preview's `bars`, with its geometry kept: a minimum bar height of one bar
      // width so a zero day is a dot rather than nothing, and today drawn last, in full
      // accent with a glow, because the newest number is the one being read.
      const T = 1;
      const ih = h - 2;
      const n = byDay.length;
      const max = Math.max(1, ...byDay.map((d) => d.sent));
      const gap = Math.max(1, ((w / n) * 0.3));
      const bw = (w - gap * (n - 1)) / n;
      byDay.forEach((d, i) => {
        const bh = Math.max(bw, (d.sent / max) * ih);
        const bx = i * (bw + gap);
        const by0 = T + ih - bh;
        if (i === n - 1) {
          x.save();
          x.shadowColor = "rgba(255,105,0,.28)";
          x.shadowBlur = Math.max(3, w * 0.012);
          x.fillStyle = tok("--orange", c) || "#ff6900";
          rr(x, bx - bw * 0.05, by0, bw * 1.1, bh, bw);
          x.fill();
          x.restore();
        } else {
          x.fillStyle = tok("--bar-soft", c) || "#ffdbc4";
          rr(x, bx, by0, bw, bh, bw);
          x.fill();
        }
      });
    };

    draw();
    // The canvas is sized by the layout, so it has to be redrawn when the layout changes
    // and not only when the numbers do. A ResizeObserver catches the breakpoints and the
    // container-query unit, which a window resize listener alone would miss.
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
    // `theme` is a dependency because the fills are read from CSS custom properties, so a
    // theme flip changes the colours without changing the data.
  }, [byDay, theme]);

  const today = byDay.length ? byDay[byDay.length - 1].sent : 0;

  return (
    <canvas
      ref={ref}
      id="spark"
      role="img"
      data-testid="spark"
      aria-label={`Drips per day over the last 30 days. ${last7d ?? 0} this week, ${allTime ?? 0} all time, ${today} today.`}
    />
  );
}
