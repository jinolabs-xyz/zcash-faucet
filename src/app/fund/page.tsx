/**
 * /fund: mainnet ZEC for the server and the domain.
 *
 * TRANSCRIBED from the approved snapshot (redesign-frozen/S2-S5-20260915T2224Z,
 * `fund.html`), into the shared shell. What did NOT change is the part that matters: the
 * address still comes from validated config on the SERVER, the page is still
 * `force-dynamic`, and it still renders without a script running.
 *
 * THE ONE THING ON THIS SITE THAT IS REAL MONEY, and the design keeps saying so. Mainnet
 * sends cannot be reversed, so the warning line is beside the address rather than below
 * the fold, and the address is never rendered from a fetch that could be pending, empty or
 * wrong: if config did not validate one, this page is a 404 rather than a page with a
 * blank where an address should be.
 */
import { notFound } from "next/navigation";
import { config } from "@/lib/config";
import { CopyAddress } from "../donate/CopyAddress";
import { Shell, CHECKING_BADGE } from "@/components/Shell";

export const runtime = "nodejs";
/** Without this Next prerenders at BUILD time, when the deployment's env does not exist,
 *  and freezes whatever address was set then. An address frozen at build is the worst
 *  possible failure on the one page that takes real money. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Fund the project · Zcash Testnet Faucet",
  description: "Mainnet ZEC toward the server and the domain that run this faucet.",
};

export default function Fund() {
  const maintenance = config.maintenanceAddress.trim();
  // No address, no page. A "fund us" page with nothing to send to is an invitation to
  // send somewhere else, and the footer link is already conditional on the same value.
  if (!maintenance) notFound();

  return (
    <Shell nav={{ kind: "links" }} badge={CHECKING_BADGE} status={{ maintenanceAddress: maintenance }}>
      <section className="view hero sub" aria-label="Fund the project">
        <div className="hero-grid two">
          <div className="hero-copy">
            <p className="eyebrow mono">Zcash testnet faucet</p>
            <h1>Fund the project.</h1>
            <p className="lede">
              The faucet runs on a server that costs real money. This is the only thing here that is not testnet play money.
            </p>
            <p className="lede small">
              Want to top up the faucet itself instead? That takes testnet TAZ and costs you nothing, so{" "}
              <a href="/donate">donate TAZ</a>.
            </p>
          </div>
          <article className="card claim feature">
            <div className="panel">
              <span className="lbl">Mainnet ZEC, shielded</span>
              <code className="addr" id="fund">{maintenance}</code>
              <CopyAddress address={maintenance} label="Mainnet donation address" />
              {/* Beside the address, not under the fold. The design puts it here and it is
                  the only irreversible action on the site. */}
              <p className="warn-line">Check the address first. Mainnet sends cannot be reversed.</p>
            </div>
            <div className="card-copy">
              <h2>Pays for the server</h2>
              <p>Copy the address into your wallet. It arrives shielded, and it pays for the server and the domain.</p>
            </div>
          </article>
        </div>
      </section>
    </Shell>
  );
}
