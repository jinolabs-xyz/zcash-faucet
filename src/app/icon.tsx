import { ImageResponse } from "next/og";
import { ACCENT, INK, MARK_RING, MARK_VIEWBOX, MARK_Z, PAPER } from "./zcashMark";

/** PNG fallback for browsers that ignore icon.svg. Was a hand-drawn Z from the old design (#646). */
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: INK, position: "relative" }}>
        <svg width="44.4" height="44.4" viewBox={MARK_VIEWBOX} fill={PAPER} style={{ position: "absolute", left: 9.8, top: 6.0 }}>
          <path d={MARK_RING} />
          <path d={MARK_Z} />
        </svg>
        {/* The banner rule, under the mark rather than framing it: at 16px a border eats the letterform. */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 8, background: ACCENT }} />
      </div>
    ),
    size,
  );
}
