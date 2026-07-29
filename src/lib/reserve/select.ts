/**
 * Which refill implementation the config calls for. Pure and import-free like
 * decide.ts, so every combination is unit-testable without reloading the
 * config module (env is read once at boot). The rules, in order:
 *
 *   shielding off   → noop, always. Nothing moves funds without an explicit opt-in.
 *   sender=zallet   → zallet, shield mature coinbase into the faucet account.
 *   anything else   → noop. The real (transparent) sender has no self-refill.
 *
 * This keys off FAUCET_SHIELD_COINBASE, not FAUCET_MINER_ACTIVE, and the
 * distinction is the whole of #172. The app never mines — that is the miner
 * container and zebra — so the only thing a refiller here can do is shield
 * coinbase we already hold, which is a self-transfer with no fork risk. Gating
 * that on the mining switch meant a correct decision about mining silently
 * disabled fund recovery, and 47.5 TAZ sat unswept through a shortage. Whether
 * we may MINE and whether we may SWEEP are different questions.
 */
export type RefillerKind = "noop" | "zallet";

export function selectRefillerKind(opts: {
  shieldCoinbase: boolean;
  sender: string;
}): RefillerKind {
  if (!opts.shieldCoinbase) return "noop";
  if (opts.sender === "zallet") return "zallet";
  return "noop";
}
