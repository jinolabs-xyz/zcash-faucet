/**
 * Where the TAZ comes from, in one sentence that follows the numbers beside it.
 *
 * Three sentences used to sit on the site at once: "refilled by hand", "mining and
 * shielding its own coins", and "the income rounds to zero", next to a panel showing
 * hundreds of accepted blocks, coinbase shielding on, and a four-figure balance (risk
 * register II, R-39). Each was true when written and none was checked against the
 * state it was rendered beside. This is the one place the sentence is made, from the
 * same facts the status panel shows, so it cannot disagree with them.
 */
export interface IncomeFacts {
  /** The miner is running (heartbeat fresh). */
  minerActive: boolean;
  /** Blocks the network accepted from us, or null when the heartbeat does not say. */
  accepted: number | null;
  /** The reserve loop is allowed to shield coinbase into the spendable balance. */
  shieldCoinbase: boolean;
}

export function incomeSentence(f: IncomeFacts): string {
  const n = f.accepted ?? 0;
  if (f.minerActive && n > 0 && f.shieldCoinbase) {
    return `The faucet mines testnet blocks and shields the coinbase into its own reserve (${n.toLocaleString("en-US")} block${n === 1 ? "" : "s"} accepted so far); donations top it up.`;
  }
  if (n > 0 && !f.shieldCoinbase) {
    return `The faucet has had ${n.toLocaleString("en-US")} block${n === 1 ? "" : "s"} accepted, but it is not shielding the coinbase into its reserve right now, so what it hands out is donated or topped up by hand.`;
  }
  if (f.minerActive) {
    return "The faucet mines, but it has not had a block accepted yet, so what it hands out is donated or topped up by hand.";
  }
  return "The faucet is not mining right now, so what it hands out is donated or topped up by hand.";
}
