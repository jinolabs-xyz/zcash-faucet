/**
 * /terms: who operates this service, and on what basis.
 *
 * WHY IT EXISTS. The MIT licence covers the CODE. It says nothing about the SERVICE
 * we run at a public URL, so until now a visitor was offered a live service with no
 * stated terms, no warranty position, and no way to contact whoever runs it. That is
 * the gap this closes.
 *
 * Written in the same plain voice as the rest of the site rather than in boilerplate.
 * Terms nobody can read protect nobody: a person who cannot tell what they are
 * agreeing to has not been told anything, whatever the word count says.
 *
 * Server rendered, like /donate and /fund, so it is readable with JavaScript off.
 * A page whose job is to state obligations must not depend on a script running.
 */
import type { CSSProperties } from "react";
import Link from "next/link";
import { config } from "@/lib/config";
import { BrandMark } from "../BrandMark";

export const runtime = "nodejs";
/**
 * Same reason as /donate and /fund: without this Next prerenders at BUILD time,
 * when the deployment's env does not exist, and freezes whatever operator and
 * contact were set then. A terms page naming the wrong operator is worse than none.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Terms · Zcash Testnet Faucet",
  description: "Who operates this faucet, and on what basis it is provided.",
};

const muted = (pct: number): string => `color-mix(in srgb, var(--color-text) ${pct}%, transparent)`;
const pad = "clamp(16px,4vw,26px)";
const h2: CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, letterSpacing: ".14em",
  textTransform: "uppercase", color: "var(--color-accent-text)", margin: "0 0 8px",
};
const body: CSSProperties = { margin: "0 0 6px", fontSize: 14, lineHeight: 1.6, color: muted(72) };

/** Last substantive change to these terms. Bump it when the text changes, not when
 *  the file is touched: a date that moves for a typo teaches people to ignore it. */
const UPDATED = "31 July 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 style={h2}>{title}</h2>
      {children}
    </section>
  );
}

export default function Terms() {
  const { operator, operatorUrl, contact, network } = config;

  return (
    <div
      className="app ink"
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--color-bg)", color: "var(--color-text)", fontFamily: "var(--font-body)" }}
    >
      <header className="nav" style={{ padding: `14px ${pad}`, gap: 14, flexWrap: "wrap" }}>
        <div className="nav-brand" style={{ fontSize: "clamp(15px,4vw,18px)", letterSpacing: "-.01em", marginRight: "auto", display: "flex", alignItems: "center", gap: ".44em" }}>
          <BrandMark />
          <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>Zcash Testnet Faucet</Link>
        </div>
        <Link className="btn btn-secondary btn-sm" href="/" aria-label="Back to the faucet">
          <span className="nav-back-long">Back to the faucet</span>
          <span className="nav-back-short">Back</span>
        </Link>
      </header>

      <main style={{ flex: 1, width: "100%", maxWidth: 680, margin: "0 auto", padding: `clamp(22px,5vw,46px) ${pad} 60px`, display: "flex", flexDirection: "column", gap: 26 }}>
        <div>
          <h1 style={{ fontSize: "clamp(27px,7.4vw,40px)", lineHeight: 1.08, letterSpacing: "-.025em", margin: "0 0 10px" }}>
            Terms of use.
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55, color: muted(70), maxWidth: "54ch" }}>
            A free testnet tool, provided as-is. Short, because terms nobody reads protect
            nobody.
          </p>
        </div>

        <Section title="Who runs this">
          <p style={body}>
            This faucet is operated by <b>{operator}</b>
            {operatorUrl ? (
              <> (<a href={operatorUrl} style={{ color: "var(--color-accent-text)" }}>{operatorUrl.replace(/^https?:\/\//, "")}</a>)</>
            ) : null}
            . It is an independent community project. It is <b>not</b> an official Zcash
            service and is not affiliated with, sponsored by, or endorsed by the Electric
            Coin Company or the Zcash Foundation.
          </p>
        </Section>

        <Section title="What you get">
          <p style={body}>
            Testnet ZEC (TAZ) on the Zcash <b>{network}</b> network, free of charge, for
            testing and development. <b>TAZ has no monetary value</b> and is not a currency,
            a security, an investment, or a promise of anything. It cannot be exchanged for
            money, and we do not buy it back.
          </p>
          <p style={body}>
            Amounts and limits shown on the site are current settings, not commitments, and
            may change at any time.
          </p>
        </Section>

        <Section title="No warranty, and no uptime promise">
          <p style={body}>
            The service is provided <b>&ldquo;as is&rdquo;, without warranty of any kind</b>,
            express or implied, including fitness for a particular purpose. We do not
            guarantee that it will be available, that a request will succeed, or that a
            transaction will confirm.
          </p>
          <p style={body}>
            To the fullest extent the law allows, {operator} is not liable for any loss or
            damage arising from use of this service, including lost time, lost test funds,
            or reliance on anything shown on the site. Testnet networks can be reset or
            reorganised by their operators, and that is outside our control.
          </p>
        </Section>

        <Section title="Fair use">
          <p style={body}>
            Take what you need for testing. Do not attempt to bypass the rate limits, the
            proof-of-work gate, or the per-address cooldown, and do not use automation to
            drain the faucet. We may block requests, addresses or networks that do, so that
            the tap stays available to everyone else.
          </p>
        </Section>

        <Section title="Donations">
          <p style={body}>
            Donations are <b>voluntary and non-refundable</b>. Testnet TAZ sent to the faucet
            goes back out as drips. Mainnet ZEC sent to the project address goes toward
            running costs such as the server and the domain.
          </p>
          <p style={body}>
            A donation <b>buys nothing</b>: no priority, no larger amount, no shorter
            cooldown, no support commitment. Blockchain transactions cannot be reversed, so
            check any address before you send to it.
          </p>
        </Section>

        <Section title="Privacy">
          <p style={body}>
            We do not use analytics, tracking or advertising cookies. IP addresses are used
            only to derive a salted hash for rate limiting, and the raw address is never
            written to a log or a database. Full detail is in{" "}
            <a href="https://github.com/jinolabs-xyz/zcash-faucet/blob/main/PRIVACY.md" style={{ color: "var(--color-accent-text)" }}>PRIVACY.md</a>.
          </p>
        </Section>

        <Section title="Trademarks and licence">
          <p style={body}>
            &ldquo;Zcash&rdquo; and the Zcash logo are trademarks of the Electric Coin
            Company, used here to identify the network this faucet serves. Their use by
            third parties is governed by the{" "}
            <a href="https://zfnd.org/zcash-trademark-policy/" style={{ color: "var(--color-accent-text)" }}>Zcash Foundation&rsquo;s trademark policy</a>.
          </p>
          <p style={body}>
            The source code is open source under the MIT licence and is available on{" "}
            <a href="https://github.com/jinolabs-xyz/zcash-faucet" style={{ color: "var(--color-accent-text)" }}>GitHub</a>.
            The licence covers the code; it does not cover this hosted service, which is what
            these terms are for.
          </p>
        </Section>

        <Section title="Contact">
          {contact ? (
            <p style={body}>
              Questions, or a problem with the service:{" "}
              <a href={contact.includes("@") ? `mailto:${contact}` : contact} style={{ color: "var(--color-accent-text)" }}>{contact}</a>.
              For security issues please follow{" "}
              <a href="https://github.com/jinolabs-xyz/zcash-faucet/blob/main/SECURITY.md" style={{ color: "var(--color-accent-text)" }}>SECURITY.md</a>.
            </p>
          ) : (
            /* Says what is missing rather than pretending. An operator who has not set
               FAUCET_CONTACT has not published one, and inventing a plausible address
               on a terms page would be worse than the gap it hides. */
            <p style={body}>
              This deployment has not published a contact address. If you run it, set{" "}
              <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>FAUCET_CONTACT</span>.
              Issues and security reports can go through{" "}
              <a href="https://github.com/jinolabs-xyz/zcash-faucet" style={{ color: "var(--color-accent-text)" }}>the repository</a>.
            </p>
          )}
        </Section>

        <Section title="Changes">
          <p style={body}>
            These terms may change. The current version is always the one on this page.
            Last updated <b>{UPDATED}</b>.
          </p>
        </Section>
      </main>

      <div style={{ position: "sticky", bottom: 0, borderTop: "2px solid var(--color-divider)", background: "var(--color-surface)", padding: `10px ${pad}`, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".05em", color: muted(50) }}>{network}</span>
        <Link className="btn btn-ghost btn-sm" href="/" style={{ marginLeft: "auto", padding: 0 }}>Get TAZ &rarr;</Link>
      </div>
    </div>
  );
}
