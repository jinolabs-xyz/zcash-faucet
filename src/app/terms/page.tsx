/**
 * /terms: who operates this service, and on what basis.
 *
 * TRANSCRIBED from the approved snapshot (redesign-frozen/S2-S5-20260915T2224Z,
 * `terms.html`), into the shared shell. Two things did not change and both are the reason
 * this page exists in the form it does.
 *
 * STILL SERVER RENDERED, STILL READABLE WITH NO JAVASCRIPT. A page whose job is to state
 * obligations must not depend on a script running. The shell around it is a client island
 * for the theme toggle and the badge; everything below is in the HTML before anything
 * hydrates, and `force-dynamic` keeps the operator and contact from being frozen at build
 * time into a deployment that has not happened yet.
 *
 * STILL WRITTEN TO BE READ. Terms nobody can read protect nobody, and a person who cannot
 * tell what they are agreeing to has not been told anything, whatever the word count says.
 */
import { config } from "@/lib/config";
import { dripsNow } from "@/lib/db";
import { Shell, CHECKING_BADGE } from "@/components/Shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Terms · Zcash Testnet Faucet",
  description: "Who operates this faucet, and on what basis it is provided.",
};

export default async function Terms() {
  // The strip's counts, read on the SERVER so they are in the HTML before anything
  // hydrates. Same call /api/status makes. This replaced a client fetch the Shell could
  // never read, and a count that needs a script is absent for the reader these pages are for.
  const drips = await dripsNow();
  const { operator, operatorUrl, contact, network } = config;
  const host = operatorUrl ? operatorUrl.replace(/^https?:\/\//, "") : null;

  return (
    <Shell nav={{ kind: "links" }} badge={CHECKING_BADGE} status={{ maintenanceAddress: config.maintenanceAddress.trim(), drips }}>
      <section className="view hero sub" aria-label="Terms of use">
        <div className="hero-copy" style={{ width: "100%" }}>
          <p className="eyebrow mono">Zcash testnet faucet</p>
          <h1>Terms of use.</h1>
          <p className="lede">A free testnet tool, provided as is. Short, because terms nobody reads protect nobody.</p>
        </div>

        <div className="terms">
          <div>
            <h2>Who runs this</h2>
            {/* OPERATOR AND CONTACT COME FROM CONFIG, not from the snapshot's hardcoded
                "Jino Labs". The spec is a design, and a terms page naming the wrong
                operator is worse than no terms page: this is the sentence a person would
                rely on to know who they are dealing with. */}
            {/* THE ATTRIBUTION LIVES HERE AND NOWHERE ELSE (CTO, 22:25Z, revising 19:38Z).
                The masthead's brand block dropped the z.cash link, and the trademark
                policy's condition is not to hold yourself out as official or endorsed
                rather than to hyperlink anything - so this sentence is what lets the site
                show the mark at all.

                The 19:38Z ruling asked S5 to add a second sentence saying the same thing
                in "Trademarks and licence". I asked which of the two should stand rather
                than shipping both, and the ruling was withdrawn in favour of this one: one
                statement, in one place, where a reader looks for it. Two sentences stating
                one fact in two sections is how they drift apart, and a trademark statement
                that drifts is the one you cannot afford to lose. */}
            <p>
              {/* NO <b>, because the snapshot has none (terms.html:425). The name is
                  config-driven and that departure is argued above; the EMPHASIS was not
                  argued anywhere, it just crept in. */}
              This faucet is operated by {operator}
              {host ? <> (<a href={operatorUrl}>{host}</a>)</> : null}, an independent community project, not
              affiliated with, sponsored by, or endorsed by the Electric Coin Company or the Zcash Foundation.
            </p>

            <h2>What you get</h2>
            <p>
              {/* The snapshot reads "on the Zcash testnet," - no emphasis and no second
                  noun. `{network}` stays config-driven so a fork publishes its own; the <b>
                  and the word "network" were drift on a page whose wording is the product. */}
              Testnet ZEC (TAZ) on the Zcash {network}, free of charge, for testing and development.{" "}
              <b>TAZ has no monetary value</b> and is not a currency, a security, an investment, or a promise of
              anything. It cannot be exchanged for money, and we do not buy it back.
            </p>
            <p>Amounts and limits shown on the site are current settings, not commitments, and may change at any time.</p>

            <h2>Fair use</h2>
            <p>
              Take what you need for testing. Do not bypass the rate limits, the proof-of-work gate, or the
              per-address cooldown, and do not use automation to drain the faucet. We may block requests, addresses
              or networks that do, so the tap stays available to everyone else.
            </p>
          </div>

          <div>
            <h2>No warranty, and no uptime promise</h2>
            <p>
              The service is provided &ldquo;as is&rdquo;, without warranty of any kind, express or implied,
              including fitness for a particular purpose. We do not guarantee that it will be available, that a
              request will succeed, or that a transaction will confirm.
            </p>
            <p>
              To the fullest extent the law allows, {operator} is not liable for any loss or damage arising from use
              of this service, including lost time, lost test funds, or reliance on anything shown on the site.
              Testnet networks can be reset or reorganised by their operators, and that is outside our control.
            </p>

            <h2>Donations</h2>
            <p>
              Donations are voluntary and non-refundable. Testnet TAZ sent to the faucet goes back out as drips.
              {config.maintenanceAddress.trim() ? (
                <> Mainnet ZEC sent to the <a href="/fund">fund address</a> pays for the server and domain.</>
              ) : null}
            </p>
          </div>

          <div>
            <h2>Privacy</h2>
            {/* THE SNAPSHOT'S OWN WORDING (S2-S5-20260915T2224Z), and it started as a
                finding of mine. The 2110Z spec said "Addresses and IPs are never logged"
                in this paragraph while its OWN FOOTER said "hashed, never stored raw" -
                two different claims about one fact on one page, and the paragraph even
                asserted they were the same sentence. That is the claim SDE-App blocked
                #562 over and the CTO ruled on at 19:38Z, surviving in the most binding
                place on the site.

                The spec was corrected rather than the rule waived, which is the right way
                round: the terms page carries the PRECISE statement and the footer carries
                the short form, so the divergence belongs to nobody and a reviewer diffing
                this against the snapshot finds them identical. "never logged" now appears
                nowhere on the page. */}
            <p>
              No accounts, no cookies, no trackers. Your address and your IP are used only to derive a salted hash
              for rate limiting, kept until the purge window drops the row, and the raw values are never written to
              a log or a database. The footer of every page says the short form, hashed, never stored raw. Full
              detail is in{" "}
              <a href="https://github.com/jinolabs-xyz/zcash-faucet/blob/main/PRIVACY.md">PRIVACY.md</a>.
            </p>

            <h2>Trademarks and licence</h2>
            <p>
              Zcash and the Zcash mark belong to their owners and are used under the{" "}
              <a href="https://zfnd.org/zcash-trademark-policy/">Zcash Foundation&rsquo;s trademark policy</a>. The
              faucet&rsquo;s source is public on{" "}
              <a href="https://github.com/jinolabs-xyz/zcash-faucet">GitHub</a>.
            </p>
            <h2>Contact and changes</h2>
            <p>
              {contact ? (
                <>
                  Questions and reports go to <a href={`mailto:${contact}`}>{contact}</a> or the repository&rsquo;s
                  issue tracker.
                </>
              ) : (
                <>Questions and reports go to the repository&rsquo;s issue tracker.</>
              )}{" "}
              These terms may change, and the version on this page is the one that applies.
            </p>
          </div>
        </div>
      </section>
    </Shell>
  );
}
