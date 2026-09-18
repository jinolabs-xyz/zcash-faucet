/**
 * /donate: testnet TAZ back into the tank, and a mining address for anyone who would
 * rather point hashpower at it.
 *
 * TRANSCRIBED from the approved snapshot (redesign-frozen/S2-S5-20260915T2224Z,
 * `donate.html`), into the shared shell. Every server-side read below is unchanged from
 * the page this replaces, deliberately: the addresses come from validated config on the
 * SERVER, so they are in the HTML before a script runs and there is no state in which
 * this page shows a spinner where an address should be. That is the owner's rule and it
 * is also the only safe way to render an address.
 *
 * THE INCOME SENTENCE FOLLOWS THE MINER, IT IS NOT COPY (R-39). This page once said "the
 * income rounds to zero" beside a balance the miner had filled. `incomeSentence()` is
 * made from the same facts the status panel shows, so the two cannot disagree, and the
 * snapshot's flat "The faucet mines testnet blocks" is a DEPARTURE I am not taking: the
 * miner is parked today, and a page that says we mine while the status card one click
 * away says we do not is the same defect in new markup.
 */
import { config, ZATOSHI_PER_TAZ } from "@/lib/config";
import { dripsNow } from "@/lib/db";
import { safeBalance } from "@/lib/zcash/send";
import { readMinerHeartbeat } from "@/lib/miner/read";
import { isActive, publicMinerView } from "@/lib/miner/heartbeat";
import { getReserveReconciler } from "@/lib/reserve/reconciler";
import { incomeSentence } from "@/lib/incomeSentence";
import { CopyAddress } from "./CopyAddress";
import { Shell, CHECKING_BADGE } from "@/components/Shell";

export const runtime = "nodejs";
/** Without this Next prerenders at BUILD time, when the deployment's env does not exist,
 *  and freezes whatever address was set then. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Donate TAZ · Zcash Testnet Faucet",
  description: "Send testnet TAZ back to the faucet, or point a miner at it.",
};

export default async function Donate() {
  // The strip's counts, read on the SERVER so they are in the HTML before anything
  // hydrates. Same call /api/status makes. This replaced a client fetch the Shell could
  // never read, and a count that needs a script is absent for the reader these pages are for.
  const drips = await dripsNow();
  const donation = config.donationAddress.trim();
  const mining = config.miningAddress.trim();
  const maintenance = config.maintenanceAddress.trim();

  const balanceZat = await safeBalance();
  // THE PUBLIC HALF, AND THE WRAP IS THE GUARD (#679 follow-up). This page reads the heartbeat
  // directly, outside /api/status, so the projection that keeps the operator fields off the wire
  // does not reach it. It takes two scalars and forwards nothing today - but Next serialises
  // server-component props to the client, so a future `<Shell miner={miner}>` here would ship the
  // operator half to every visitor without anyone touching route.ts. Typed as
  // Omit<MinerReading, "operator">, that edit stops compiling instead of needing a reviewer.
  const miner = publicMinerView(readMinerHeartbeat(config.miner.heartbeatPath));
  const reserveState = getReserveReconciler().status;
  const income = incomeSentence({
    minerActive: isActive(miner.state),
    accepted: miner.submittedAccepted ?? null,
    shieldCoinbase: config.reserve.shieldCoinbase,
    harvestFailing: reserveState.lastFailure?.outcome === "error" && reserveState.failedSteps > 0,
  });
  const spendable = balanceZat === null ? null : Number(balanceZat) / Number(ZATOSHI_PER_TAZ);

  return (
    <Shell nav={{ kind: "links" }} badge={CHECKING_BADGE} status={{ maintenanceAddress: maintenance, drips }}>
      <section className="view hero sub" aria-label="Donate TAZ">
        <div className="hero-grid two">
          <div className="hero-copy">
            <p className="eyebrow mono">Zcash testnet faucet</p>
            <h1>Keep the tank full.</h1>
            <p className="lede">
              {income} Donations keep drips going out either way.
            </p>
            <p className="lede small">
              {/* THE SNAPSHOT'S OWN SENTENCE (S2-S5-20260915T2224Z). The 2110Z spec read
                  "In the tank: unknown", which carried the one prose colon on the site
                  against the owner's rule and against the CTO's own verification of zero.
                  I measured it, they corrected the SPEC rather than waiving the rule, and
                  this is their wording so the divergence belongs to nobody.

                  UNKNOWN, NEVER ZERO. A wallet we could not read is not an empty wallet,
                  and "0 TAZ" on the page asking for donations is the most misleading place
                  on the site to get that wrong. */}
              The tank holds <b>{spendable == null ? "unknown" : `${Math.round(spendable).toLocaleString("en-US")} TAZ`}</b>. Supporting the
              running costs rather than the tank? That takes real mainnet ZEC, so{" "}
              {/* Conditional for the same reason the footer link is: an unconditional link to a
                  page with nothing on it is worse than no link. THE FULL STOP LIVES IN EACH
                  BRANCH, because "instead" belongs to the link and only to the link: hanging it
                  outside the ternary gave the no-address deployment "...that needs a mainnet
                  address we do not have set instead.", which is a sentence nobody wrote. Two
                  endings, each one whole. */}
              {maintenance ? (
                <>
                  <a href="/fund">fund the project</a> instead.
                </>
              ) : (
                <span>that needs a mainnet address this deployment has not set.</span>
              )}
            </p>
          </div>
          <article className="card claim feature">
            {/* NO ADDRESS IS A STATE THIS PAGE MUST RENDER, and mine did not until an existing
                api-integration case caught it. The snapshot hardcodes an address and never
                draws this state, so transcribing it literally left an EMPTY code box with a
                Copy address button beside it - a control that copies nothing, on the page
                whose entire job is handing over an address. The page this replaces said "No
                address configured" plainly.

                So the state is composed in the design's own shapes rather than invented in a
                new one, the same way /fund's is: the lbl says what is missing, the hint says
                what an operator does about it, and no copy button is offered for something
                that is not there. Second time tonight that a check somebody else wrote months
                ago found an unstated gap in my transcription. */}
            {donation ? (
              <div className="panel">
                <span className="lbl">Donate TAZ, shielded</span>
                <code className="addr" id="don">{donation}</code>
                <CopyAddress address={donation} label="Donation address" variant="panel" />
                <p className="hint">Arrives shielded. Testnet only, so it costs you nothing and goes straight back out as drips.</p>
              </div>
            ) : (
              <div className="panel">
                <span className="lbl">No address configured</span>
                <p className="hint">
                  This deployment has not published a donation address, so there is nothing to send to here. If you
                  run it, set <code className="mono">FAUCET_DONATION_ADDRESS</code>.
                </p>
              </div>
            )}
            <div className="card-copy">
              <h2>Or point a miner at us</h2>
              <p>Transparent, because a coinbase cannot pay a shielded output. Any block that survives funds the faucet.</p>
              {/* THE SAME GAP, ONE BLOCK LOWER, and it is the reason to sweep rather than to fix
                  what a check happened to point at. The api case that caught the donation block
                  keys on the donation sentence and cannot see this one, so a deployment with no
                  mining address configured got an empty box and a Copy button that copies an
                  empty string, on the same page, four lines down. SDE-App's note on the block
                  asked for a pass over every not-configured path on every page this PR touches
                  rather than the two that happened to have checks. This is what the pass found,
                  and the sweep's other reads are named in the PR body. */}
              {mining ? (
                <>
                  <code className="addr small" id="mine">{mining}</code>
                  <CopyAddress address={mining} label="Mining address" variant="chip" />
                </>
              ) : (
                <p className="hint">
                  No mining address is configured here, so there is nowhere to point hashpower. If you run it,
                  set <code className="mono">FAUCET_MINING_ADDRESS</code>.
                </p>
              )}
            </div>
          </article>
        </div>
      </section>
    </Shell>
  );
}
