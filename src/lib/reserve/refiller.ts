/**
 * The refill action behind the reconciler. One `step()` is one bounded unit of
 * refill work — the reconciler calls it repeatedly (through the send queue)
 * while the hysteresis says "refilling", so a drip only ever waits behind a
 * single step, never a whole refill.
 *
 * Which implementation you get:
 *   FAUCET_MINER_ACTIVE=false  → NoopRefiller. The loop runs, decides, and
 *     reports state honestly, but moves no funds. This is the pre-cutover
 *     default: mining on a syncing node would fork us off the real chain.
 *   miner active + zallet      → ZalletRefiller (./zalletRefiller.ts), shields
 *     mature coinbase into the faucet's Orchard account. Mining itself is the
 *     miner container's job; our step is the shield leg.
 */
import { config } from "../config";
import { selectRefillerKind } from "./select";

export interface Refiller {
  readonly name: string;
  /** One bounded refill unit. Resolves when it lands, throws on failure. */
  step(): Promise<void>;
}

class NoopRefiller implements Refiller {
  readonly name = "noop";
  async step(): Promise<void> {}
}

let cached: Refiller | null = null;

export function getRefiller(): Refiller {
  if (cached) return cached;
  const kind = selectRefillerKind({ minerActive: config.miner.active, sender: config.sender });
  if (kind === "zallet") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = new (require("./zalletRefiller").ZalletRefiller)() as Refiller;
  } else {
    cached = new NoopRefiller();
  }
  return cached;
}
