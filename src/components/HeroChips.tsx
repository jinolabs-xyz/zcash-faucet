/**
 * The hero's status chips, transcribed from the approved snapshot
 * (redesign-frozen/S2-S5-20260915T2224Z, index.html 413-421).
 *
 * ALWAYS IN THE HTML, FILLED WHEN THE STATUS ARRIVES, and that is the whole shape of this
 * component rather than a detail of it. The index is a client island, so `status` is null on the
 * server and nothing derived from it can be in the first paint. The puzzle sentence one element
 * up was written `{status?.challenge === "pow" && ...}` and has therefore been absent from the
 * served HTML of every deployment since it shipped - the owner found it missing from prod, and
 * the code was there the whole time. Gating the chips the same way would ship that defect again
 * in new markup.
 *
 * So the chips render unconditionally: the labels, the dots and the words, with `unknown` where
 * a figure is not known yet. That is what the preview does (its chips are in the HTML with
 * placeholder numbers and its script fills them) and it is the CHECKING badge's rule from S5 -
 * say what you have established, and say you have not established it when you have not.
 *
 * THE WORDS AND TONES COME FROM `statusView.ts`, NOT FROM A SECOND DERIVATION. The status view
 * already computes every one of these, and two derivations of "what word describes the faucet
 * right now" is how the hero and the status card come to disagree on one page (R-24). Mapped
 * from the preview's own script: wallet is `wt` (index.html:925), which is exactly `reserveTone`;
 * node is `s.node.ready ? 'ok' : 'warn'` (:927); miner is `tone(minerWord)` (:928); sends is
 * `tone(s.sends.state)` (:929); the ops chip is hidden unless the box is unwell (:931).
 */
"use client";

import {
  groupDigits,
  heightDiff,
  heightDiffChip,
  minerWord,
  minerTone,
  nodeChipTone,
  reserveTone,
  boxTone,
  } from "@/lib/statusView";


export interface HeroChipStatus {
  balanceTaz?: number | null;
  /** null when the wallet did not answer, which is a state the server really sends (#573). */
  node?: { ready?: boolean; nodeHeight?: number | null; externalHeight?: number | null } | null;
  miner?: Parameters<typeof minerWord>[0];
  box?: { state?: string; minerUnit?: string | null };
  sends?: { state?: string };
  reserve?: { spendableTaz?: number | null; lowTaz?: number | null; targetTaz?: number | null };
  drips?: { last7d?: number | null } | null;
}

function Chip({
  name,
  tone,
  children,
  onOpen,
}: {
  name: string;
  tone: string;
  children: React.ReactNode;
  onOpen: () => void;
}) {
  return (
    <button className="tag" type="button" data-chip={name} data-tone={tone} onClick={onOpen}>
      <span className="sdot" aria-hidden="true" />
      {children}
    </button>
  );
}

export function HeroChips({
  status,
  onView,
}: {
  status: HeroChipStatus | null;
  onView: (view: "status" | "analytics") => void;
}) {
  const node = status?.node;
  const diff = heightDiff(node?.nodeHeight, node?.externalHeight);
  const unit = status?.box?.minerUnit ?? null;
  const boxState = status?.box?.state;
  const week = status?.drips?.last7d;

  return (
    <>
      <div className="chips" id="chips" aria-label="Faucet status">
        {/* A CHIP GOES WITH ITS FIGURE (owner, 2026-09-19). "wallet unknown" in a coloured pill
            is a status claim about a status we do not have, and a row of them is how the hero
            looked whenever a poll failed. No figure, no chip. */}
        {status?.balanceTaz != null && (
        <Chip name="wallet" tone={reserveTone(status?.reserve)} onOpen={() => onView("status")}>
          wallet <b>{`${groupDigits(Math.round(status.balanceTaz))} TAZ`}</b>
        </Chip>
        )}
        {node?.nodeHeight != null && (
        <Chip name="node" tone={nodeChipTone(node?.ready)} onOpen={() => onView("status")}>
          node <b>{groupDigits(node.nodeHeight)}</b>
          {/* The second figure is the delta, and it is absent rather than "(unknown)" when we
              have nothing to compare against - the design shows a parenthetical only when there
              is one. */}
          {diff == null ? null : <b>{heightDiffChip(diff)}</b>}
        </Chip>
        )}
        {/* Same rule, and this one is the pre-first-poll case: with no status at all the chip
            used to render "miner unknown". The WORD the miner gets once status arrives is
            minerLabel's business, not this file's - SDE-UI is changing it separately. */}
        {status && (
        <Chip name="miner" tone={minerTone(status.miner, unit)} onOpen={() => onView("status")}>
          miner <b>{minerWord(status.miner, unit)}</b>
        </Chip>
        )}
        {/* THE SENDS CHIP IS GONE with its card. Its verdict needs three completed sends inside
            fifteen minutes and prod serves about one drip every two hours, so it read "unknown"
            permanently. The gate itself is untouched: a degraded wallet still stops claims and
            still shows on the card as "Not taking claims right now". */}
        {/* ONE WORD ABOUT THE BOX AND NEVER A FAULT NAME (R-24), and hidden while it is well -
            the snapshot carries `hidden` on this chip and the script clears it. Hidden here
            means not rendered: an element with `hidden` is still in the accessibility tree for
            some assistive technology, and "OPS ATTENTION" read out on a healthy faucet is worse
            than the chip being absent.

            ATTENTION ONLY, AND UNKNOWN IS NOT ATTENTION. The first version was `boxState &&
            boxState !== "ok"`, with `boxState === "failing" ? "bad" : "warn"`. `publicBox()`
            emits exactly ok | attention | unknown, so "failing" was a branch nothing could
            reach and the whole non-ok half collapsed to warn - which meant a box that has simply
            not reported showed OPS ATTENTION in a warning tone, next to a miner chip and a sends
            chip both quietly saying `unknown`. boxLabel.ts had already decided this in words -
            "'attention' would claim a fault the box never reported" - and the chip claimed it
            anyway. Found by SDE-Infra on the #591 review; the shape is R-24 again, two places
            deciding one thing and only one of them reading the rule. The tone now comes from
            `boxTone` in statusView.ts, which the status view uses for the same state. */}
        {boxState === "attention" ? (
          <button className="tag ops" type="button" data-chip="box" data-tone={boxTone(boxState)} onClick={() => onView("status")}>
            OPS ATTENTION
          </button>
        ) : null}
        <button className="tag more" type="button" data-view="status" onClick={() => onView("status")}>
          Full status →
        </button>
      </div>
      {/* THE COUNT DROPS OUT OF THE SENTENCE rather than being replaced by a word. The old
          comment here was right that 0 is a fact and not a placeholder - the fix for that is
          not to write "unknown drips this week", it is to stop making the claim and still
          offer the link. */}
      <a className="morelink" href="#analytics" data-view="analytics" onClick={(e) => { e.preventDefault(); onView("analytics"); }}>
        {week == null ? "Usage analytics →" : <><span className="num">{groupDigits(week)}</span> drips this week. Usage analytics →</>}
      </a>
    </>
  );
}
