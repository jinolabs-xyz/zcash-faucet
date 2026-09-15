/**
 * The Status view: three equal cards, transcribed from the approved preview
 * (redesign-frozen/S2-S5-20260915T2110Z, the `data-view="status"` section).
 *
 * Each card is a panel with one figure over a table of detail, and the split is the
 * point: the figure is what a visitor reads, the table is what an operator reads, and
 * neither one is allowed to say more than /api/status actually told us.
 *
 * ONE WORD PER STATE ON THE PUBLIC PAGE and never a fault name (R-24). The words here
 * come from the label helpers in src/lib, which already hold that rule and its history;
 * this file decides layout and nothing else.
 */
"use client";

import { useEffect, useRef } from "react";
import type { FaucetNetwork } from "@/lib/network";
import { drawReserve } from "@/lib/charts";
import {
  groupDigits,
  heightDiff,
  heightDeltaText,
  heightTone,
  syncFigure,
  syncBarPercent,
  dripsLeftText,
  reserveTone,
  minerWord,
  minerTone,
  acceptSentence,
  backendHost,
} from "@/lib/statusView";
import type { Tone, ViewStatus } from "./viewStatus";
import { UNKNOWN } from "./viewStatus";

/** The reserve miniature on the wallet card. Redraws on theme and on every poll. */
function ReserveMini({ status }: { status: ViewStatus | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const paint = () =>
      drawReserve(
        canvas,
        canvas,
        {
          spendableTaz: status?.reserve?.spendableTaz ?? null,
          lowTaz: status?.reserve?.lowTaz ?? null,
          targetTaz: status?.reserve?.targetTaz ?? null,
          refilling: status?.reserve?.refilling ?? false,
          balanceLabel: "",
        },
        true,
      );
    paint();
    // The canvas carries no layout of its own, so a width change has to be observed
    // rather than inferred from the window: this card is inside a grid that goes from
    // three columns to one, and a resize listener misses every one of those reflows
    // that does not also change the window.
    const ro = new ResizeObserver(paint);
    ro.observe(canvas);
    // The tokens it paints with are per theme, and the toggle rewrites an attribute on
    // <html> rather than firing an event.
    const mo = new MutationObserver(paint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [status]);

  return <canvas ref={ref} id="c-reserve-mini" height={46} role="img" aria-label="Wallet reserve against its low mark and target" />;
}

function Rows({ children }: { children: React.ReactNode }) {
  return <dl className="rows">{children}</dl>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A state word, coloured by its tone rather than by a lookup on the word itself. */
function Word({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className="word" data-tone={tone}>
      {children}
    </span>
  );
}

export function StatusCards({ status, network }: { status: ViewStatus | null; network: FaucetNetwork }) {
  const node = status?.node;
  const diff = heightDiff(node?.nodeHeight, node?.externalHeight);
  const ready = node?.ready ?? false;

  const miner = status?.miner;
  const unit = status?.box?.minerUnit ?? null;
  const minerState = minerWord(miner, unit);
  const sends = status?.sends;
  const reserve = status?.reserve;

  // A figure we were not given reads "unknown", never zero. "0 TAZ" for a wallet we
  // failed to read is the single most expensive lie this page could tell, because it is
  // also exactly what a genuinely empty wallet looks like.
  const height = node?.nodeHeight != null ? groupDigits(node.nodeHeight) : UNKNOWN;
  const external = node?.externalHeight != null ? groupDigits(node.externalHeight) : UNKNOWN;
  const balance = status?.balanceTaz != null ? `${groupDigits(Math.round(status.balanceTaz))} TAZ` : UNKNOWN;
  const spendable = reserve?.spendableTaz != null ? groupDigits(Math.round(reserve.spendableTaz)) : UNKNOWN;
  const accepted = miner?.submittedAccepted != null ? groupDigits(miner.submittedAccepted) : UNKNOWN;
  const syncPercent = syncBarPercent(node?.syncPercent, ready);

  return (
    <div className="grid3">
      <article className="card">
        <div className="panel">
          <div className="metric">
            <span className="lbl">Node height</span>
            <div className="metric-row">
              {/* data-status-key replaces the deleted strip's data-strip-key: ui-smoke reads
                  these three cell by cell to prove first paint states nothing it was not
                  told. A body-wide regex cannot do that job, because "0.1 TAZ" is
                  legitimately on the page. */}
              <strong data-status-key="node">{height}</strong>
            </div>
            <span className="delta" data-tone={heightTone(diff)}>
              {heightDeltaText(diff)}
            </span>
          </div>
          <div>
            <span className="lbl">Sync {syncFigure(node?.syncPercent, ready)}</span>
            <div
              className="prog"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              /* Omitted rather than zeroed when we have no percentage: aria-valuenow="0"
                 announces a sync that has not started, which is a different claim from
                 one we cannot measure. An absent value is what indeterminate means. */
              aria-valuenow={node?.syncPercent == null ? undefined : syncPercent}
              aria-label="Node sync"
              style={{ marginTop: "calc(.5*var(--u))" }}
            >
              <i style={{ "--w": `${syncPercent}%` } as React.CSSProperties} />
            </div>
          </div>
        </div>
        <div className="card-copy">
          <h2>Node</h2>
          <Rows>
            {/* Both heights are named by their source. "height" alone was ambiguous in
                every incident review: ours, or the network's? */}
            <Row label="Our height">{height}</Row>
            <Row label="Independent reference">{external}</Row>
            <Row label="Backend">
              <span className="rdot" data-on={String(Boolean(status?.backend?.reachable))} />
              {backendHost(status?.backend?.endpoint)}
            </Row>
          </Rows>
        </div>
      </article>

      <article className="card">
        <div className="panel">
          <div className="metric">
            <span className="lbl">Wallet</span>
            <div className="metric-row">
              <strong data-status-key="balance">{balance}</strong>
            </div>
            {/* SPENDABLE ONLY, NEVER FALLING BACK TO THE TOTAL BALANCE. Two different
                quantities, and the card shows both: the figure above is everything the
                wallet holds, this line is how many drips we can actually pay out.
                Coinbase we have not shielded yet is in the first and not the second. The
                fallback that used to be here would print a confident "about N drips" off
                the total whenever the spendable read failed, overstating the faucet's
                reach at exactly the moment it knows least - the same family as a null
                balance reading as empty, one line from the comment warning about it.
                Unknown spendable reads "balance unknown", which is what the preview does. */}
            <span className="delta" data-tone={reserveTone(reserve)}>
              {dripsLeftText(reserve?.spendableTaz, status?.dripTaz ?? 0)}
            </span>
          </div>
          <ReserveMini status={status} />
        </div>
        <div className="card-copy">
          <h2>Wallet</h2>
          <Rows>
            <Row label="Spendable">{spendable === UNKNOWN ? UNKNOWN : `${spendable} TAZ`}</Row>
            <Row label="Reserve line">
              {reserve?.targetTaz != null ? groupDigits(reserve.targetTaz) : UNKNOWN} · low{" "}
              {reserve?.lowTaz != null ? groupDigits(reserve.lowTaz) : UNKNOWN}
            </Row>
            <Row label="Drip">
              {status?.dripTaz ?? UNKNOWN} TAZ · 24h cooldown
            </Row>
            {/* cTAZ follows the network the claim view has selected, exactly as the
                preview does. It is parked, so the word is the one the rest of the site
                uses for it and there is no figure beside it to imply otherwise. */}
            {network === "ctaz" && (
              <>
                <div>
                  <div className="group">cTAZ</div>
                </div>
                <Row label="cTAZ">
                  <Word tone="unknown">parked</Word>
                </Row>
              </>
            )}
          </Rows>
        </div>
      </article>

      <article className="card">
        <div className="panel">
          <div className="metric">
            <span className="lbl">Blocks accepted by our node</span>
            <div className="metric-row">
              <strong>{accepted}</strong>
            </div>
            <span className="delta">{acceptSentence(miner)}</span>
          </div>
          <div className="chips" style={{ justifyContent: "flex-start", gap: "calc(.5*var(--u))" }}>
            <span className="tag" data-tone={minerTone(miner, unit)}>
              <span className="sdot" />
              miner <b data-status-key="miner">{minerState}</b>
            </span>
            <span className="tag" data-tone={sendsTone(sends?.state)}>
              <span className="sdot" />
              sends <b>{sends?.state ?? UNKNOWN}</b>
            </span>
            <span className="tag" data-tone={boxTone(status?.box?.state)}>
              <span className="sdot" />
              box <b>{status?.box?.state ?? UNKNOWN}</b>
            </span>
          </div>
        </div>
        <div className="card-copy">
          <h2>Operations</h2>
          <Rows>
            <Row label="Miner">
              <Word tone={minerTone(miner, unit)}>{minerState}</Word>
              {miner?.templateAgoSeconds != null && <> · template {miner.templateAgoSeconds}s</>}
            </Row>
            <Row label="Solved / accepted / rejected">
              {miner?.solvedCount ?? UNKNOWN} / {miner?.submittedAccepted ?? UNKNOWN} / {miner?.submittedRejected ?? UNKNOWN}
            </Row>
            <Row label="Sends">
              <Word tone={sendsTone(sends?.state)}>{sends?.state ?? UNKNOWN}</Word>
              {sends?.reason && <> · {sends.reason}</>}
            </Row>
            <Row label="Box">
              <Word tone={boxTone(status?.box?.state)}>{status?.box?.state ?? UNKNOWN}</Word>
            </Row>
          </Rows>
        </div>
      </article>
    </div>
  );
}

/**
 * Tones for the two states that arrive as words rather than as a reading.
 *
 * ANYTHING UNRECOGNISED IS UNKNOWN, never ok. A newer box that reports a state this
 * build has not heard of must not be painted green by a `!== "bad"` test, which is how
 * an unrecognised value ends up reassuring.
 */
function sendsTone(state: string | undefined): Tone {
  if (state === "ok") return "ok";
  if (state === "degraded") return "warn";
  if (state === "failing") return "bad";
  return "unknown";
}

function boxTone(state: string | undefined): Tone {
  if (state === "ok") return "ok";
  if (state === "attention") return "warn";
  return "unknown";
}
