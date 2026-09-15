/**
 * The Tools view: the balance lookup and how the faucet is run, transcribed from the
 * approved preview (redesign-frozen/S2-S5-20260915T2110Z, the `data-view="tools"`
 * section).
 *
 * THE LOOKUP IS THE APP'S, NOT THE PREVIEW'S. The preview's form answers "0.3 TAZ across
 * 2 outputs (example)" from a regex, which is right for a design mock and would be a
 * fabricated balance on a live faucet. The real one POSTs to /api/balance - POST rather
 * than GET so the address never lands in a proxy log or a browser history (R-36) - and
 * this component takes it as props rather than reimplementing it.
 */
"use client";

import { groupDigits, acceptSentence } from "@/lib/statusView";
import type { ViewStatus } from "./viewStatus";
import { UNKNOWN } from "./viewStatus";

export interface ToolsCardsProps {
  status: ViewStatus | null;
  address: string;
  onAddressChange: (value: string) => void;
  onLookup: () => void;
  result: string;
  /** Where the TAZ comes from, already derived from the same facts the panel shows
   *  (R-39). Null until the first status lands, so no sentence is rendered on a guess. */
  incomeSentence: string | null;
}

export function ToolsCards({ status, address, onAddressChange, onLookup, result, incomeSentence }: ToolsCardsProps) {
  const accepted = status?.miner?.submittedAccepted;

  return (
    <div className="grid2">
      <article className="card">
        <div className="panel">
          <span className="lbl" id="lookup-l">
            Balance lookup
          </span>
          <form
            id="lookupform"
            onSubmit={(e) => {
              e.preventDefault();
              onLookup();
            }}
          >
            <input
              className="prompt"
              id="laddr"
              type="text"
              placeholder="Testnet address"
              aria-labelledby="lookup-l"
              autoComplete="off"
              spellCheck={false}
              value={address}
              onChange={(e) => onAddressChange(e.target.value)}
            />
            <button className="tag ink" type="submit">
              Look up
            </button>
          </form>
          {/* aria-live so the answer is announced when it arrives. The lookup is
              asynchronous and the result replaces a paragraph that was empty, which a
              screen reader otherwise never revisits. */}
          <p className="ans" id="lans" aria-live="polite">
            {result}
          </p>
        </div>
        <div className="card-copy">
          <h2>Balance lookup</h2>
          <p>Transparent balances are public on chain. Shielded balances are private. Provide a viewing key in a wallet to see this.</p>
        </div>
      </article>

      <article className="card">
        <div className="panel">
          <div className="metric">
            <span className="lbl">Where the TAZ comes from</span>
            <div className="metric-row">
              <strong>{accepted != null ? `${groupDigits(accepted)} blocks` : UNKNOWN}</strong>
            </div>
            <span className="delta">{acceptSentence(status?.miner)}</span>
          </div>
        </div>
        <div className="card-copy" data-testid="how-it-works">
          <h2>How it works</h2>
          <p>The faucet runs its own Zcash testnet node and shielded wallet. Nothing is delegated to a hosted service, and the page shows what the node can prove.</p>
          {/* DEPARTURE from the preview, and it is R-39 again. The preview hardcodes
              "The TAZ comes from blocks our node mines (255 accepted so far) and from
              donations", which is a sentence that does not follow the state beside it:
              the miner is parked today, so that line would claim the faucet mines while
              the card one click away says it does not. incomeSentence is made from the
              same facts the panel shows and cannot disagree with them. */}
          {incomeSentence && <p>{incomeSentence}</p>}
          <p>It can run empty. When it does, this page says so and the button waits for a refill instead of promising one.</p>
        </div>
      </article>
    </div>
  );
}
