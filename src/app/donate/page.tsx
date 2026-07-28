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
import { config, ZATOSHI_PER_TAZ } from "@/lib/config";
import { safeBalance } from "@/lib/zcash/send";
import { CopyAddress } from "./CopyAddress";

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
  letterSpacing: ".14em", textTransform: "uppercase", color: "var(--color-accent)",
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

  const balanceZat = await safeBalance();
  const spendable = balanceZat === null ? null : Number(balanceZat) / Number(ZATOSHI_PER_TAZ);
  const target = Number(config.reserve.targetZatoshi) / Number(ZATOSHI_PER_TAZ);
  const fillPct = spendable != null && target > 0 ? Math.min(100, Math.round((spendable / target) * 100)) : null;
  const dripsLeft = spendable != null && config.dripTaz > 0 ? Math.floor(spendable / config.dripTaz) : null;

  return (
    <div
      className="app ink"
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--color-bg)", color: "var(--color-text)", fontFamily: "var(--font-body)" }}
    >
      <header className="nav" style={{ padding: `14px ${pad}`, gap: 14, flexWrap: "wrap" }}>
        <div className="nav-brand" style={{ fontSize: "clamp(15px,4vw,18px)", letterSpacing: "-.01em", marginRight: "auto" }}>
          Zcash Testnet Faucet
        </div>
        <a className="btn btn-secondary btn-sm" href="/">Back to the faucet</a>
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

        <div className="hr" style={{ margin: "6px 0 0" }} />
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: muted(55) }}>
          Testnet only. TAZ has no monetary value, so this is not a fundraiser, it is a way to keep a
          shared testing tool available to the next person who needs it.
        </p>
      </main>

      <div style={{ position: "sticky", bottom: 0, borderTop: "2px solid var(--color-divider)", background: "var(--color-surface)", padding: `10px ${pad}`, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".05em", color: muted(50) }}>{config.network}</span>
        <a className="btn btn-ghost btn-sm" href="/" style={{ marginLeft: "auto", padding: 0 }}>Get TAZ →</a>
      </div>
    </div>
  );
}
