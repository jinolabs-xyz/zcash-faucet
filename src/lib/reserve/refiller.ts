/**
 * The refill action behind the reconciler. One `step()` is one bounded unit of
 * refill work — the reconciler calls it repeatedly (through the send queue)
 * while the hysteresis says "refilling", so a drip only ever waits behind a
 * single step, never a whole refill.
 *
 * Which implementation you get:
 *   FAUCET_SHIELD_COINBASE=false → NoopRefiller. The loop still runs, decides
 *     and reports state honestly, it just moves no funds. Default, because a
 *     shield broadcasts a transaction and that stays an explicit opt-in.
 *   shielding on + zallet        → ZalletRefiller (./zalletRefiller.ts), shields
 *     mature coinbase into the faucet's Orchard account. Mining itself is the
 *     miner container's job; our step is only ever the shield leg.
 *
 * `step()` reports its OUTCOME rather than returning void. A shield that finds
 * nothing to sweep used to be indistinguishable from one that moved funds, and
 * from a loop that was not running at all (#172) — so the caller now gets enough
 * to tell those apart and say so.
 */
// .ts extensions throughout: Next resolves extensionless specifiers, node --test
// does not, and this module had never been loaded by a test until the shield gate
// needed the whole refill path exercised end to end.
import { config } from "../config.ts";
import type { ShieldFreshness } from "../zcash/shieldGate.ts";
import { selectRefillerKind } from "./select.ts";
import { ZalletRefiller } from "./zalletRefiller.ts";

export interface StepOutcome {
  /** True only when funds actually moved: an operation was submitted and landed. */
  moved: boolean;
  /**
   * Set when the step DECLINED to broadcast, rather than trying and finding
   * nothing. A refusal and an empty sweep are both `moved: false` and mean
   * opposite things: one is "the chain view is too stale to build a valid
   * transaction", the other is "there was nothing here". Folding them together
   * would report a safety refusal as an absence of coinbase, which is the same
   * mistake as reading a missing count as a zero (#174).
   */
  refused?: { state: ShieldFreshness; reason: string; lag: number | null };
  /**
   * UTXOs the backend still sees as shieldable, when it reports the figure.
   * Zero versus non-zero is what separates "there is nothing here" from "there
   * is plenty here and I cannot see it", which is the question #172 could not
   * answer because this value was received and thrown away.
   */
  remainingUTXOs?: number;
}

export interface Refiller {
  readonly name: string;
  /** One bounded refill unit. Resolves with what happened, throws on failure. */
  step(): Promise<StepOutcome>;
}

class NoopRefiller implements Refiller {
  readonly name = "noop";
  async step(): Promise<StepOutcome> {
    return { moved: false };
  }
}

let cached: Refiller | null = null;

export function getRefiller(): Refiller {
  if (cached) return cached;
  const kind = selectRefillerKind({
    shieldCoinbase: config.reserve.shieldCoinbase,
    sender: config.sender,
  });
  if (kind === "zallet") {
    // Static import rather than the require() this used to do. `require` is not
    // defined in an ES module, so the lazy version made every caller unloadable
    // outside Next's CJS server bundle, and the lazy load bought nothing:
    // zalletRefiller pulls in config and two pure modules.
    cached = new ZalletRefiller();
  } else {
    cached = new NoopRefiller();
  }
  return cached;
}
