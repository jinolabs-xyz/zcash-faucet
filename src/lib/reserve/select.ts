/**
 * Which refill implementation the config calls for. Pure and import-free like
 * decide.ts, so every combination is unit-testable without reloading the
 * config module (env is read once at boot). The rules, in order:
 *
 *   miner off       → noop, always. Nothing moves funds until cutover.
 *   sender=zallet   → zallet, shield mature coinbase into the faucet account.
 *   sender=mock     → mock only with the explicit FAUCET_MOCK_REFILL opt-in.
 *                     A mock deploy must never silently "mine".
 *   anything else   → noop. The real (transparent) sender has no self-refill.
 */
export type RefillerKind = "noop" | "mock" | "zallet";

export function selectRefillerKind(opts: {
  minerActive: boolean;
  sender: string;
  mockRefill: boolean;
}): RefillerKind {
  if (!opts.minerActive) return "noop";
  if (opts.sender === "zallet") return "zallet";
  if (opts.sender === "mock" && opts.mockRefill) return "mock";
  return "noop";
}
