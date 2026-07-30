/**
 * What the live panel says about the reserve.
 *
 * WHY IT IS A FUNCTION AND NOT INLINE JSX. The panel showed two adjacent rows,
 * `reserve 257.2 / 1000 TAZ` and `refill idle`, and a reader reasonably concluded the
 * loop was broken. It was not. The band is LOW=100 and TARGET=1000, and 257.2 sits
 * inside it, so decideRefilling holds its previous state, which was false after a
 * container restart. Nothing was wrong except the display.
 *
 * Two separate faults in those eleven characters:
 *
 *   the fraction named the TARGET, which nothing pursues while idle, and omitted the
 *   LOW mark, which is the number that actually decides
 *
 *   "idle" gave no reason, so it read as "stalled" rather than "not needed yet"
 *
 * So the target is quoted only while a refill is running, because that is the only
 * time anything is aiming at it, and the low mark is quoted while idle, because that
 * is what would start one. Pure and exported so the wording is testable without a
 * browser: the honesty of a sentence is a property worth pinning, and the browser
 * smoke is a slow and indirect way to assert on prose.
 */
export interface ReserveFacts {
  spendableTaz: number | null;
  lowTaz: number;
  targetTaz: number;
  refilling: boolean;
  /**
   * Consecutive throws from the refill step, and why. WANTING to refill and being ABLE
   * to are different states, and "topping up" claims the second. The loop spent a day
   * saying it while every tick threw "Insufficient balance (have 0)", which is not a
   * fault, it is having no coinbase to shield on a testnet where we lose block races.
   */
  failedSteps?: number;
  lastFailure?: { outcome: "waiting" | "error"; reason: string } | null;
}

export interface ReserveRows {
  /** The balance line. No denominator, because which one applies depends on state. */
  reserve: string;
  /** The refill line, which carries the number that explains the state. */
  refill: string;
}

export function reserveRows(r: ReserveFacts): ReserveRows {
  // A null balance is "we could not read it", never 0. Reporting 0.0 here would say
  // the faucet is empty when the truth is that the wallet did not answer, and that is
  // the same not-seen-versus-cannot-say confusion the rest of the codebase refuses.
  const balance = r.spendableTaz == null ? "unknown" : `${r.spendableTaz.toFixed(1)} TAZ`;

  if (r.refilling) {
    // Refilling is the intent. Whether anything can happen is a separate fact, and
    // conflating them is what put TOPPING UP on screen while nothing could top up.
    const stuck = (r.failedSteps ?? 0) > 0 ? r.lastFailure : null;
    if (stuck?.outcome === "waiting") {
      return { reserve: balance, refill: "waiting, nothing to shield yet" };
    }
    if (stuck?.outcome === "error") {
      return { reserve: balance, refill: `refill FAILING, ${r.failedSteps} consecutive` };
    }
    return { reserve: balance, refill: `topping up to ${r.targetTaz.toFixed(0)} TAZ` };
  }

  // Idle, and the reason depends on which side of the mark we are on. Below it with no
  // refill running means the loop cannot act, usually because shielding is off, and
  // saying "idle" there would hide a real condition behind a normal-sounding word.
  if (r.spendableTaz != null && r.spendableTaz < r.lowTaz) {
    return { reserve: balance, refill: `idle BELOW the ${r.lowTaz.toFixed(0)} TAZ mark` };
  }

  return { reserve: balance, refill: `idle, starts under ${r.lowTaz.toFixed(0)} TAZ` };
}
