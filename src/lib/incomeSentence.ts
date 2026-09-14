/**
 * Where the TAZ comes from, in one sentence that follows the numbers beside it.
 *
 * Three sentences used to sit on the site at once: "refilled by hand", "mining and
 * shielding its own coins", and "the income rounds to zero", next to a panel showing
 * hundreds of accepted blocks, coinbase shielding on, and a four-figure balance (risk
 * register II, R-39). Each was true when written and none was checked against the
 * state it was rendered beside. This is the one place the sentence is made, from the
 * same facts the status panel shows, so it cannot disagree with them.
 *
 * It says nothing about donations. The pages that render it add their own donation
 * line where one belongs, and a sentence that carried one read twice on /donate.
 */
export interface IncomeFacts {
  /** The miner is running (heartbeat fresh). */
  minerActive: boolean;
  /**
   * Blocks OUR NODE accepted from the miner (submitblock returned null), or null when
   * the heartbeat does not carry the count. Not blocks the network kept: MINING.md
   * records that most of them are orphaned, so the sentence says "its node accepted"
   * and never implies each one funded the reserve.
   */
  accepted: number | null;
  /** The reserve loop is allowed to shield coinbase into the spendable balance. */
  shieldCoinbase: boolean;
  /** The shielding step is failing right now (the panel shows "harvest FAILING"). */
  harvestFailing?: boolean;
}

const blocks = (n: number) => `${n.toLocaleString("en-US")} block${n === 1 ? "" : "s"}`;

export function incomeSentence(f: IncomeFacts): string {
  const byHand = "so what it hands out is donated or topped up by hand.";
  // A parked miner earns nothing today whatever its history says, and whatever the
  // shielding flag says.
  if (!f.minerActive) return `The faucet is not mining right now, ${byHand}`;
  // A count of zero is a fact; a missing count is not, and is not read as zero.
  if (f.accepted === 0) return `The faucet mines, but its node has not accepted a block from it yet, ${byHand}`;
  const won = f.accepted == null ? "" : `, and its node has accepted ${blocks(f.accepted)} from it so far`;
  if (!f.shieldCoinbase) {
    return `The faucet mines testnet blocks${won}, but it is not shielding what it wins into its reserve right now, ${byHand}`;
  }
  if (f.harvestFailing) {
    return `The faucet mines testnet blocks${won}, and is set up to shield what it wins into its own reserve, but that step is failing right now, ${byHand}`;
  }
  return `The faucet mines testnet blocks and shields what it wins into its own reserve${won ? ` (its node has accepted ${blocks(f.accepted!)} from it so far, not all of which stay on the network)` : ""}.`;
}
