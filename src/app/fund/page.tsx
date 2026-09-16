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
import { config } from "@/lib/config";
import { dripsNow } from "@/lib/db";
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

export default async function Fund() {
  // The strip's counts, read on the SERVER so they are in the HTML before anything
  // hydrates. Same call /api/status makes. This replaced a client fetch the Shell could
  // never read, and a count that needs a script is absent for the reader these pages are for.
  const drips = await dripsNow();
  const maintenance = config.maintenanceAddress.trim();

  return (
    <Shell nav={{ kind: "links" }} badge={CHECKING_BADGE} status={{ maintenanceAddress: maintenance, drips }}>
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
          {/* NO ADDRESS IS A STATE THIS PAGE RENDERS, NOT A 404, and that is the behaviour
              this page already had. I wrote notFound() here first, reasoning that a "fund us"
              page with nothing to send to invites sending somewhere else. It is a defensible
              product argument and it was an UNSTATED CHANGE to shipped behaviour that the
              snapshot does not ask for - and it went red in a check that already existed: the
              mobile audit visits /fund and a 404 there logs a console error. An existing check
              caught an unstated departure, which is the check doing its job.

              So the page keeps its two states, transcribed into the design's card. The footer
              link stays conditional on the same value, and ui-smoke pins that the two agree. */}
          {maintenance ? (
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
          ) : (
            <article className="card claim feature">
              <div className="panel">
                <span className="lbl">No address configured</span>
                <p className="hint">
                  This deployment has not published a mainnet address, so there is nothing to send to here. If you
                  run it, set <code className="mono">FAUCET_MAINTENANCE_ADDRESS</code>.
                </p>
              </div>
              <div className="card-copy">
                <h2>Pays for the server</h2>
                <p>When an address is set it appears here, and the footer gains its Fund ZEC link at the same time.</p>
              </div>
            </article>
          )}
        </div>
      </section>
    </Shell>
  );
}
