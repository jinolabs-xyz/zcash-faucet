import { ImageResponse } from "next/og";
import { ACCENT, INK, MARK_RING, MARK_VIEWBOX, MARK_Z, PAPER } from "./zcashMark";

/**
 * The share card, the first thing most people see of this faucet - it is what renders
 * in Slack, Discord, X and Signal. It was still the pre-redesign dark card (#646).
 * Generated rather than a committed PNG so it follows the palette instead of drifting
 * from it; brandMark.ts owns both the colours and the trademark paths.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Zcash Testnet Faucet - shielded TAZ from a faucet that runs its own node and wallet";

const chip = { border: `2px solid ${INK}22`, borderRadius: 6, padding: "10px 18px", fontSize: 22, color: `${INK}cc` };

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex", flexDirection: "column", justifyContent: "center",
          width: "100%", height: "100%", background: PAPER, color: INK,
          padding: "0 86px", borderBottom: `14px solid ${ACCENT}`,
          fontFamily: "sans-serif",
        }}
      >
        <svg width="96" height="96" viewBox={MARK_VIEWBOX} fill={INK}>
          <path d={MARK_RING} />
          <path d={MARK_Z} />
        </svg>
        <div style={{ fontSize: 82, fontWeight: 700, letterSpacing: -2, marginTop: 30 }}>Zcash Testnet Faucet</div>
        <div style={{ fontSize: 31, color: `${INK}b0`, marginTop: 14 }}>
          Shielded TAZ from a faucet that runs its own node and wallet.
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 40 }}>
          <div style={{ ...chip, color: ACCENT, border: `2px solid ${ACCENT}` }}>Shielded z-to-z</div>
          <div style={chip}>Zebra + Zallet</div>
          <div style={chip}>Browser proof of work</div>
        </div>
      </div>
    ),
    size,
  );
}
