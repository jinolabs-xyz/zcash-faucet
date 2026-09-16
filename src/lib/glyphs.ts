/**
 * The card-title glyphs, transcribed VERBATIM from the approved preview's `glyph()`
 * (redesign-frozen/S2-S5-20260915T1958Z, index.html). Five of the preview's twelve are used
 * here, one before each analytics card title.
 *
 * WHY THEY WERE MISSING is worth recording, because it was not an oversight about one element.
 * `<canvas>` carries no content, so a heading without its glyph LOOKS finished: the title is
 * there, the chip is there, the layout is right, and nothing in a screenshot diff at the card
 * level says a 16px icon is absent. Every other canvas in this slice draws data and shows up
 * blank when it is wrong; these draw furniture and show up as nothing at all.
 *
 * THE COORDINATES ARE COPIED, NOT RETYPED, on a 16x16 grid scaled by the element's own width,
 * exactly as the preview does. A number here that disagrees with the preview is a typo, and
 * the tests drive every path against a recording context so a dropped `stroke()` is caught
 * without a browser.
 */

/** The 2D calls a glyph makes. Narrow on purpose, so a test double is a few lines. */
export interface GlyphContext {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void;
  quadraticCurveTo(a: number, b: number, c: number, d: number): void;
  arc(x: number, y: number, r: number, from: number, to: number, ccw?: boolean): void;
  stroke(): void;
  fill(): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

export const GLYPHS = ["drips", "reserve", "miner", "sends", "network"] as const;
export type GlyphName = (typeof GLYPHS)[number];

/**
 * Draws one glyph on the preview's 16x16 grid. The caller owns scale, colour and line width,
 * which is the same split the preview uses: `glyph()` sets them once from the element's own
 * computed colour, so a glyph follows the theme without being told about it.
 */
export function drawGlyph(x: GlyphContext, name: GlyphName): void {
  // The preview's own helper: a polyline, begun but not stroked, so each case decides.
  const P = (...pts: [number, number][]) => {
    x.beginPath();
    pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])));
  };
  switch (name) {
    case "drips":
      x.beginPath();
      x.moveTo(8, 2.5);
      x.bezierCurveTo(8, 5, 3.5, 8, 3.5, 10.5);
      x.arc(8, 10.5, 4.5, Math.PI, 0, true);
      x.bezierCurveTo(12.5, 8, 8, 5, 8, 2.5);
      x.stroke();
      break;
    case "reserve":
      x.strokeRect(3.5, 2.5, 9, 11);
      x.fillRect(3.5, 8.5, 9, 5);
      break;
    case "miner":
      P([4, 12.5], [11.5, 5]);
      x.stroke();
      x.beginPath();
      x.moveTo(7.5, 3.2);
      x.quadraticCurveTo(11.5, 2.4, 13.4, 6.8);
      x.stroke();
      break;
    case "sends":
      P([3, 8], [13, 8]);
      x.stroke();
      P([9.5, 4.5], [13, 8], [9.5, 11.5]);
      x.stroke();
      break;
    case "network":
      ([[3.2, 12.2], [12.8, 12.2], [8, 3.8]] as [number, number][]).forEach((p) => {
        x.beginPath();
        x.arc(p[0], p[1], 1.6, 0, 7);
        x.fill();
      });
      P([3.8, 10.8], [7.4, 5.2]);
      x.stroke();
      P([12.2, 10.8], [8.6, 5.2]);
      x.stroke();
      P([5, 12.2], [11, 12.2]);
      x.stroke();
      break;
  }
}

/**
 * Sets up a glyph canvas the way the preview's `glyph()` does and draws into it: square from
 * the element's own width, device-pixel scaled, painted in the element's computed colour so
 * the theme carries without a prop.
 */
export function paintGlyph(canvas: HTMLCanvasElement, name: GlyphName): void {
  const r = canvas.getBoundingClientRect();
  const s = r.width || 16;
  const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  canvas.width = Math.round(s * dpr);
  canvas.height = Math.round(s * dpr);
  const x = canvas.getContext("2d");
  if (!x) return;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, s, s);
  // The preview scales the 16-grid to the element: `x.scale(k, k)` with k = s / 16.
  const k = s / 16;
  x.scale(k, k);
  const col = getComputedStyle(canvas).color;
  x.strokeStyle = col;
  x.fillStyle = col;
  x.lineWidth = 1.5;
  x.lineCap = "round";
  x.lineJoin = "round";
  drawGlyph(x, name);
}
