import { holding, type Phase } from "./faucetPhase.ts";
import type { FaucetNetwork } from "./network.ts";

/** Just the reserve fields this panel reads, so a caller cannot pass the wrong block. */
export type ReserveView = {
  spendableTaz?: number | null;
  lowTaz?: number | null;
  refilling?: boolean | null;
} | null | undefined;

/**
 * WHETHER THE PANEL SHOWS, AS A PURE FUNCTION, BECAUSE THE GATE IS WHERE THE BUG WAS.
 *
 * #659 moved this panel out of the claim card on the owner's instruction, with the argument
 * that the reserve is a fact about the WALLET and not a step in the claim. Then I gated it on
 * `phase === "ready"` - a claim phase - so it vanished the moment a claim started. The owner
 * caught it twice: proof-of-work makes the phase `submitting`, and being rate-limited makes it
 * `cooldown`, and the panel disappeared in both. That is #659's own argument not carried into
 * the code that implements it.
 *
 * SO THE RULE IS NOT "WHICH CLAIM PHASE ARE WE IN" BUT "WOULD THE PANEL BE LYING". Its copy
 * asserts two things - the reserve is low, and CLAIMS STILL WORK - so it must be hidden exactly
 * where one of those is false, and nowhere else:
 *
 *   holding (checking/syncing/fault)  we cannot verify anything, and "claims still work"
 *                                     directly contradicts a page that is saying it cannot send
 *   empty                             worse than low, and the card already says so; "low" beside
 *                                     "empty" reads as two different answers to one question
 *   degraded                          sends are degraded, so "claims still work" is not ours to
 *                                     promise
 *
 * Everything else keeps it, INCLUDING submitting, cooldown, success and error - a claim in
 * flight, a rate-limited visitor and a failed attempt do not change the wallet's float.
 *
 * It is a separate exported function rather than a condition in the JSX so that every phase is
 * a DECISION with a row against it: the unit test enumerates all eleven, so adding a twelfth
 * fails until someone says which side it falls on.
 */
export function reserveLowVisible(phase: Phase, reserve: ReserveView, network: FaucetNetwork): boolean {
  if (network !== "taz") return false;
  // The reconciler's own decision, not our arithmetic on its numbers - the same reason the
  // card reads `refilling` rather than comparing spendable against the low mark itself.
  if (!reserve?.refilling) return false;
  return !holding(phase) && phase !== "empty" && phase !== "degraded";
}
