/**
 * /donate — the long-form version of the empty-state prompt.
 *
 * Deliberately plain about why this page exists: the faucet mines, mining
 * income is currently zero (#42), so donations are what keep it serving. No
 * begging, no urgency theatre, just the situation and an address.
 *
 * Server rendered on purpose. The addresses and the story are readable with no
 * JavaScript, which is the right call for a page whose job is handing over an
 * address, and it means the not-configured state is real HTML rather than
 * something that only appears after a fetch. Only the copy buttons are client
 * side. Numbers are fresh per request (force-dynamic) rather than polled: a
 * donation page does not need a live-updating gauge, it needs to be right when
 * you open it.
 */
import type { CSSProperties } from "react";
import Link from "next/link";
import { config, ZATOSHI_PER_TAZ } from "@/lib/config";
import { safeBalance, safeDonations } from "@/lib/zcash/send";
import { CopyAddress } from "./CopyAddress";
import { BrandMark } from "../BrandMark";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Donate TAZ — Zcash Testnet Faucet",
  description: "Keep the testnet faucet serving. Donations arrive shielded.",
};

const muted = (pct: number): string => `color-mix(in srgb, var(--color-text) ${pct}%, transparent)`;

const pad = "clamp(16px,4vw,26px)";
const kicker: CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
  letterSpacing: ".14em", textTransform: "uppercase", color: "var(--color-accent-text)",
};
const addrBox: CSSProperties = {
  border: "2px solid var(--color-divider)", padding: "12px 14px",
  display: "flex", flexDirection: "column", gap: 10,
};
const addrText: CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.5,
  wordBreak: "break-all", fontWeight: 700,
};

export default async function Donate() {
  const donation = config.donationAddress.trim();
  const mining = config.miningAddress.trim();
  const maintenance = config.maintenanceAddress.trim();

  // Both reads are independent and neither blocks the page, so do not serialize them.
  const [balanceZat, donations] = await Promise.all([safeBalance(), safeDonations()]);
  const spendable = balanceZat === null ? null : Number(balanceZat) / Number(ZATOSHI_PER_TAZ);
  const target = Number(config.reserve.targetZatoshi) / Number(ZATOSHI_PER_TAZ);
  const fillPct = spendable != null && target > 0 ? Math.min(100, Math.round((spendable / target) * 100)) : null;
  const dripsLeft = spendable != null && config.dripTaz > 0 ? Math.floor(spendable / config.dripTaz) : null;
  // Trim trailing zeros so a whole-TAZ donation reads "5" and not "5.00000000".
  const donatedTaz = donations
    ? (Number(donations.zat) / Number(ZATOSHI_PER_TAZ)).toFixed(8).replace(/\.?0+$/, "")
    : null;

  return (
    <div
      className="app ink"
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--color-bg)", color: "var(--color-text)", fontFamily: "var(--font-body)" }}
    >
      <header className="nav" style={{ padding: `14px ${pad}`, gap: 14, flexWrap: "wrap" }}>
        <div className="nav-brand" style={{ fontSize: "clamp(15px,4vw,18px)", letterSpacing: "-.01em", marginRight: "auto", display: "flex", alignItems: "center", gap: ".44em" }}>
          <BrandMark />
          <span>Zcash Testnet Faucet</span>
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
          <h1 style={{ fontSize: "clamp(27px,7.4vw,40px)", lineHeight: 1.08, letterSpacing: "-.025em", margin: "0 0 10px" }}>
            Keep the tank full.
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55, color: muted(70), maxWidth: "46ch" }}>
            This faucet runs its own node and wallet, and it mines. What it does not do is earn from
            mining: on public testnet a single dominant miner wins every block race, so the blocks we
            win get orphaned and the income rounds to zero. The machinery is real, the revenue is not.
            Donated TAZ is what keeps drips going out.
          </p>
        </div>

        {/* Tank gauge, same hatch meter the topping-up card uses, so a donor
            sees the same picture an operator does. */}
        <div style={{ border: "2px solid var(--color-divider)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 11 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <span style={kicker}>In the tank</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700 }}>
              {spendable == null ? "unknown" : `${spendable.toFixed(1)} / ${target.toFixed(0)} TAZ`}
            </span>
          </div>
          {fillPct != null && (
            <div role="progressbar" aria-label="Faucet reserve level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fillPct} style={{ height: 10, border: "2px solid var(--color-divider)", position: "relative", overflow: "hidden" }}>
              <i aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: fillPct + "%", background: "repeating-linear-gradient(135deg,var(--color-accent) 0 3px,transparent 3px 7px)", backgroundSize: "26px 26px" }} />
            </div>
          )}
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: muted(60) }}>
            {dripsLeft != null
              ? `About ${dripsLeft.toLocaleString("en-US")} more drips at ${config.dripTaz} TAZ each. Reload for the current figure.`
              : "The wallet is not reporting a balance right now, so this is the one number we cannot show you."}
          </p>
        </div>

        {/* Not configured is a real state, and saying so beats an empty box. */}
        {!donation && (
          <div style={{ border: "2px solid var(--color-divider)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 9 }}>
            <span style={kicker}>No address configured</span>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(62) }}>
              This deployment has not published a donation address, so there is nothing to send to
              here. If you run it, set <span style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>FAUCET_DONATION_ADDRESS</span> and this page fills in.
            </p>
          </div>
        )}

        {donation && (
          <div style={addrBox}>
            <span style={kicker}>Donate TAZ (shielded)</span>
            <span style={addrText}>{donation}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <CopyAddress address={donation} label="Donation address" />
              <span style={{ fontSize: 12, color: muted(60), maxWidth: "42ch" }}>
                Unified address, so what you send arrives shielded. The amount and the sender stay off
                the public ledger.
              </span>
            </div>
          </div>
        )}

        {/* Only rendered when the wallet could actually attribute the history. A
            counter that cannot tell a donation from our own mining income would
            publish our block rewards as generosity, so no number beats a flattering
            one. See tallyDonations for what does and does not qualify. */}
        {donations && donations.count > 0 && (
          <div style={{ border: "2px solid var(--color-divider)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 7 }}>
            <span style={kicker}>Donations received</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 17, fontWeight: 700 }}>
              {donatedTaz} TAZ <span style={{ fontSize: 12, fontWeight: 400, color: muted(60) }}>
                from {donations.count} shielded {donations.count === 1 ? "donation" : "donations"}
              </span>
            </span>
            <span style={{ fontSize: 12, lineHeight: 1.55, color: muted(60), maxWidth: "52ch" }}>
              Shielded receipts only, and it excludes anything the faucet paid itself, so this is
              money that came from outside. Someone donating to the transparent receiver would not
              appear here, because at this address that is indistinguishable from our own mining
              income and we would rather undercount than flatter ourselves.
            </span>
          </div>
        )}

        {mining && (
          <div style={addrBox}>
            <span style={kicker}>Or point a miner at us</span>
            <span style={addrText}>{mining}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <CopyAddress address={mining} label="Mining address" />
              <span style={{ fontSize: 12, color: muted(60), maxWidth: "42ch" }}>
                Transparent, because a coinbase cannot pay a shielded output. Mine to this address and
                any block that survives funds the faucet. Hashrate helps here in a way it cannot help
                us alone, since surviving a race is about share of the total.
              </span>
            </div>
          </div>
        )}

        {maintenance && (
          <>
            <div className="hr" style={{ margin: "6px 0 0" }} />
            {/* Everything above this line is testnet play money. This block is not,
                and the separation is the point: a donor who skims must not mistake
                one for the other. The heading says mainnet, the copy says mainnet,
                and the warning below says what cannot be undone. */}
            <div id="maintenance" style={{ ...addrBox, borderColor: "var(--color-accent)" }}>
              <span style={{ ...kicker, color: "var(--color-accent-text)" }}>
                Mainnet ZEC · toward running the project
              </span>
              <span style={addrText}>{maintenance}</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                <CopyAddress address={maintenance} label="Mainnet donation address" />
                <span style={{ fontSize: 12, color: muted(60), maxWidth: "42ch" }}>
                  Unified, so it arrives shielded. This one is <b>real ZEC on mainnet</b>, unlike
                  everything else on this page. It goes toward the server, the domain and the time
                  that keeps the faucet running, and it buys no advantage at the tap: drips are the
                  same size, on the same cooldown, for everyone.
                </span>
              </div>
              <span style={{ fontSize: 12, lineHeight: 1.5, color: muted(70) }}>
                Check the address before sending. A mainnet transfer cannot be reversed, and this
                page is the only place we publish it.
              </span>
            </div>
          </>
        )}

        <div className="hr" style={{ margin: "6px 0 0" }} />
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: muted(55) }}>
          The faucet itself is testnet only. TAZ has no monetary value, so topping up the tank is not
          a fundraiser, it is a way to keep a shared testing tool available to the next person who
          needs it.
        </p>
      </main>

      <div style={{ position: "sticky", bottom: 0, borderTop: "2px solid var(--color-divider)", background: "var(--color-surface)", padding: `10px ${pad}`, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".05em", color: muted(50) }}>{config.network}</span>
        <Link className="btn btn-ghost btn-sm" href="/" style={{ marginLeft: "auto", padding: 0 }}>Get TAZ →</Link>
      </div>
    </div>
  );
}
