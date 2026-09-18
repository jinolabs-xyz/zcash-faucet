import { num, type Phase } from "@/lib/faucetPhase";
import type { FaucetNetwork } from "@/lib/network";
import { reserveLowVisible, type ReserveView } from "@/lib/reserveLow";

/**
 * The low-reserve notice, in the hero column (#659).
 *
 * ITS OWN COMPONENT (owner, item 4) FOR THE REASON ITEM 2 EXISTS: while it lived inside the
 * phase block it inherited the phase's lifecycle, so it came and went with the claim. Rendering
 * it from its own gate is what stops that, and the extraction is what makes the gate testable.
 */
export default function ReserveLowPanel({ phase, reserve, network }: { phase: Phase; reserve: ReserveView; network: FaucetNetwork }) {
  if (!reserveLowVisible(phase, reserve, network)) return null;
  return (
    <div className="phase reserve-aside" data-phase="reserve-low">
      <div className="kicker">Reserve</div>
      <h3>The reserve is low</h3>
      <p>Claims still work. A refill is due, and if it runs out this page says so.</p>
      {/* THE ACTION SITS BESIDE THE FIGURES, NOT UNDER THEM (owner). One row: the figures take
          the space they need and the link takes the rest, right-aligned, so the panel gains a
          line of height rather than two. */}
      <div className="figs figs-action">
        <span><b className="num">{reserve?.spendableTaz != null ? num(Math.floor(reserve.spendableTaz)) : "-"}</b>spendable TAZ</span>
        <span><b className="num">{reserve?.lowTaz != null ? num(reserve.lowTaz) : "-"}</b>low mark</span>
        {/* /donate, NOT /fund - donate is the TAZ page ("Keep the tank full", and "Or point a
            miner at us"); fund is mainnet ZEC for the server. Asking for real money because
            TESTNET coins are low is the wrong ask.

            "or mine" RATHER THAN "or point a miner", AND I ARGUED THE OTHER WAY AND WAS WRONG.
            I wanted the longer phrase because pointing a miner is the only option here that costs
            the reader nothing but cycles, and I said I would buy the width from the layout instead
            of the copy. Measured, panel inner width against what the row needs:
              1440x900  360 vs 385  SHORT 25      1366x768  348 vs 336  fits
              1280x800  319 vs 351  SHORT 32      1280x720  326 vs 315  fits
              1024x768  297 vs 356  SHORT 59
            The entire gap between the two figures is 12px, so closing it recovers 24 - less than
            half the worst case. Nothing on the layout side covers 59px without deleting a figure
            nobody asked to remove. SDE-App measured this first and shortened it; I re-derived it
            and got the same answer.
            The meaning survives one click: /donate's own copy is "Or point a miner at us". */}
        <a className="tag reserve-act" href="/donate">Top it up, or mine &rarr;</a>
      </div>
    </div>
  );
}
