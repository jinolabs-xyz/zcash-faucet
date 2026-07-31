/**
 * 404. Wears the same chrome as /donate rather than the framework default.
 *
 * Fixed ink like /donate, and for the same reason: this renders on the server and
 * the theme toggle is client state, so there is no theme to read here. Picking
 * one beats a flash of the wrong one.
 */
import type { CSSProperties } from "react";
import Link from "next/link";
import { BrandMark } from "./BrandMark";

export const metadata = {
  title: "Not found · Zcash Testnet Faucet",
  description: "That page does not exist. The faucet is one page over.",
};

const muted = (pct: number): string => `color-mix(in srgb, var(--color-text) ${pct}%, transparent)`;
const pad = "clamp(16px,4vw,26px)";
const kicker: CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
  letterSpacing: ".14em", textTransform: "uppercase", color: "var(--color-accent-text)",
};

export default function NotFound() {
  return (
    <div
      className="app ink"
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--color-bg)", color: "var(--color-text)", fontFamily: "var(--font-body)" }}
    >
      <header className="nav" style={{ padding: `14px ${pad}`, gap: 14, flexWrap: "wrap" }}>
        <div className="nav-brand" style={{ fontSize: "clamp(15px,4vw,18px)", letterSpacing: "-.01em", marginRight: "auto", display: "flex", alignItems: "center", gap: ".44em" }}>
          {/* The LOGO hyperlinks to z.cash, which is the trademark policy's
              condition for showing it. The site NAME beside it is ours and stays
              site navigation, so the two are separate links rather than one. Nested
              anchors would be invalid markup anyway.

              New tab, deliberately: people expect a masthead mark to go home, and
              sending someone off-site mid-claim would lose whatever they had typed.
              The aria-label says where it goes so the surprise is announced. */}
          <a
            href="https://z.cash/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Zcash, opens z.cash in a new tab"
            title="Zcash"
            style={{ display: "inline-flex", flex: "none", color: "inherit" }}
          >
            <BrandMark />
          </a>
          <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>Zcash Testnet Faucet</Link>
        </div>
        <Link className="btn btn-secondary btn-sm" href="/" aria-label="Back to the faucet">
          {/* The visible label shortens at narrow widths so the masthead stays on
              one row once the mark is in it. aria-label carries the full
              destination either way: a screen reader user at 360px gets the same
              information a sighted user at 1200px does. */}
          <span className="nav-back-long">Back to the faucet</span>
          <span className="nav-back-short">Back</span>
        </Link>
      </header>

      <main style={{ flex: 1, width: "100%", maxWidth: 620, margin: "0 auto", padding: `clamp(22px,5vw,46px) ${pad} 60px`, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <span style={kicker}>404</span>
          <h1 style={{ fontSize: "clamp(27px,7.4vw,40px)", lineHeight: 1.08, letterSpacing: "-.025em", margin: "8px 0 10px" }}>
            Nothing at this address.
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55, color: muted(70), maxWidth: "46ch" }}>
            Not a Zcash address, the other kind. This faucet is a small site and there are only
            two pages on it, so a link that led here was either mistyped or is out of date.
          </p>
        </div>

        <div className="hr" style={{ margin: 0 }} />

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ ...kicker, color: muted(60) }}>Where you probably meant to go</span>
          <Link className="btn btn-primary" href="/" style={{ alignSelf: "flex-start" }}>
            Claim testnet TAZ
          </Link>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: muted(65) }}>
            Or <Link href="/donate">top the faucet up</Link> if you have spare TAZ. It runs on
            donations, because the mining it does earns nothing on a testnet one miner dominates.
          </p>
        </div>
      </main>

      <div style={{ position: "sticky", bottom: 0, borderTop: "2px solid var(--color-divider)", background: "var(--color-surface)", padding: `10px ${pad}`, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".05em", color: muted(50) }}>testnet</span>
        <Link className="btn btn-ghost btn-sm" href="/" style={{ marginLeft: "auto", padding: 0 }}>Get TAZ →</Link>
      </div>
    </div>
  );
}
