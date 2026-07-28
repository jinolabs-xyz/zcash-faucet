/**
 * Which refill implementation the config calls for. Pure and import-free like
 * decide.ts, so every combination is unit-testable without reloading the
 * config module (env is read once at boot). The rules, in order:
 *
 *   miner off       → noop, always. Nothing moves funds until cutover.
 *   sender=zallet   → zallet, shield mature coinbase into the faucet account.
 *   anything else   → noop. The real (transparent) sender has no self-refill.
 */
export type RefillerKind = "noop" | "zallet";

export function selectRefillerKind(opts: {
  minerActive: boolean;
  sender: string;
}): RefillerKind {
  if (!opts.minerActive) return "noop";
  if (opts.sender === "zallet") return "zallet";
  return "noop";
}
