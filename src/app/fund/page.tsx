/**
 * /fund: mainnet ZEC toward running the project.
 *
 * A SEPARATE PAGE FROM /donate, and the separation is the safety feature. The two
 * asks look alike (both unified, both shielded, both a QR beside a copy button) and
 * only one of them moves real money. Side by side on one page, the entire defence
 * against copying the wrong one was a coloured border and the word "mainnet". One
 * page, one network, one address is a defence that does not depend on reading
 * carefully.
 *
 * Server rendered like /donate: the address must be readable with JavaScript off,
 * because handing over an address correctly is the page's whole job. Only the copy
 * button is client side.
 */
import type { CSSProperties } from "react";
import Link from "next/link";
import { config } from "@/lib/config";
import { CopyAddress } from "../donate/CopyAddress";
import { AddressQR } from "../donate/AddressQR";
import { BrandMark } from "../BrandMark";

export const runtime = "nodejs";
/**
 * NOT OPTIONAL. Without this Next prerenders the page at BUILD time, when the
 * deployment's env does not exist yet, so it bakes in the "no address configured"
 * branch and ships a funding page with no address on it. /donate carries the same
 * line for the same reason. Caught by checking the served HTML rather than the
 * local render.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Fund the project · Zcash Testnet Faucet",
  description: "Mainnet ZEC toward the server, the domain and the upkeep of a free testnet faucet.",
};

const muted = (pct: number): string => `color-mix(in srgb, var(--color-text) ${pct}%, transparent)`;
const pad = "clamp(16px,4vw,26px)";
const kicker: CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
  letterSpacing: ".14em", textTransform: "uppercase", color: "var(--color-accent-text)",
};
const addrText: CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.5,
  wordBreak: "break-all", fontWeight: 700,
};

export default function Fund() {
  const maintenance = config.maintenanceAddress.trim();

  return (
    <div
      className="app ink"
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--color-bg)", color: "var(--color-text)", fontFamily: "var(--font-body)" }}
    >
      <header className="nav" style={{ padding: `14px ${pad}`, gap: 14, flexWrap: "wrap" }}>
        <div className="nav-brand" style={{ fontSize: "clamp(15px,4vw,18px)", letterSpacing: "-.01em", marginRight: "auto", display: "flex", alignItems: "center", gap: ".44em" }}>
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
          <span className="nav-back-long">Back to the faucet</span>
          <span className="nav-back-short">Back</span>
        </Link>
      </header>

      <main style={{ flex: 1, width: "100%", maxWidth: 620, margin: "0 auto", padding: `clamp(22px,5vw,46px) ${pad} 60px`, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h1 style={{ fontSize: "clamp(27px,7.4vw,40px)", lineHeight: 1.08, letterSpacing: "-.025em", margin: "0 0 10px" }}>
            Fund the project.
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55, color: muted(70), maxWidth: "50ch" }}>
            The faucet runs on a server that costs real money. This is the only thing here
            that is not testnet play money.
          </p>
        </div>

        {maintenance ? (
          <div style={{ border: "2px solid var(--color-accent)", padding: "16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={kicker}>Mainnet ZEC</span>
            <span style={addrText}>{maintenance}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
              <AddressQR address={maintenance} label="QR code of the mainnet donation address" />
              <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, alignItems: "flex-start", flex: "1 1 18ch" }}>
                <span style={{ fontSize: 12.5, lineHeight: 1.5, color: muted(65) }}>
                  Scan it with a Zcash wallet, or copy the address. It arrives shielded, and it
                  pays for the server and domain.
                </span>
                <CopyAddress address={maintenance} label="Mainnet donation address" />
              </div>
            </div>
            <span style={{ fontSize: 12, lineHeight: 1.5, color: "var(--color-accent-text)" }}>
              Check the address first. Mainnet sends cannot be reversed.
            </span>
          </div>
        ) : (
          <div style={{ border: "2px solid var(--color-divider)", padding: "16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ ...kicker, color: muted(60) }}>No address configured</span>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: muted(65) }}>
              This deployment has not published a mainnet address, so there is nothing to send to
              here. If you run it, set <span style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>FAUCET_MAINTENANCE_ADDRESS</span>.
            </p>
          </div>
        )}

        {/* The other ask, one click away rather than one column away. Someone who
            landed here wanting to top the faucet up should not have to guess. */}
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(55) }}>
          Want to top up the faucet itself instead? That takes testnet TAZ and costs you
          nothing: <Link href="/donate" style={{ color: "var(--color-accent-text)" }}>donate TAZ</Link>.
        </p>
      </main>

      <div style={{ position: "sticky", bottom: 0, borderTop: "2px solid var(--color-divider)", background: "var(--color-surface)", padding: `10px ${pad}`, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".05em", color: muted(50) }}>mainnet</span>
        <Link className="btn btn-ghost btn-sm" href="/" style={{ marginLeft: "auto", padding: 0 }}>Get TAZ →</Link>
      </div>
    </div>
  );
}
