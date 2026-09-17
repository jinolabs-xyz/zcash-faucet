import { ImageResponse } from "next/og";
import { ACCENT, INK, MARK_RING, MARK_VIEWBOX, MARK_Z, PAPER } from "./zcashMark";

/** iOS home screen. Was the old design's Z, which is what an added-to-home-screen user still saw (#646). */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: INK, position: "relative" }}>
        <svg width="124.9" height="124.9" viewBox={MARK_VIEWBOX} fill={PAPER} style={{ position: "absolute", left: 27.6, top: 16.9 }}>
          <path d={MARK_RING} />
          <path d={MARK_Z} />
        </svg>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 22, background: ACCENT }} />
      </div>
    ),
    size,
  );
}
