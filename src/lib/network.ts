/**
 * The two networks this faucet serves, and what the page is allowed to say about each.
 *
 * TAZ is public Zcash testnet, paid by Zallet out of our own shielded wallet. cTAZ is
 * the Crosslink feature net, paid by the node's own faucet primitive (#322). They are
 * different chains and different money, which is the whole reason this file exists:
 * every place the UI used to hardcode "TAZ" was quietly asserting there was only one.
 *
 * WHAT THIS TABLE HOLDS AND WHAT IT MUST NEVER HOLD.
 *
 * Presentation only. The ticker, the beta marking, the sentence that explains an
 * absent transaction id. It carries NO claim about what a send actually did.
 *
 * That line is worth defending, because the tempting entry is `hasTxid: false` on
 * cTAZ, and it would be wrong in a way that takes a while to hurt. The route already
 * derives the ledger's no-txid exemption from the SENDER (getSender().name), so a
 * second copy of the same fact here would be a second source of truth for it, free to
 * disagree the day a network is pointed at a sender it was not built for. The receipt
 * renders "no transaction id" because THE RESPONSE HAS NONE, not because a table
 * predicted it would, and this file only supplies the sentence explaining why.
 *
 * Pure, no config, no imports. The wording is the thing most worth testing and least
 * worth needing a browser to test.
 */

export type FaucetNetwork = "taz" | "ctaz";

/** Iteration order is display order: the default network first. */
export const NETWORKS: readonly FaucetNetwork[] = ["taz", "ctaz"];

export const DEFAULT_NETWORK: FaucetNetwork = "taz";

export interface NetworkFacts {
  /** Unit shown beside an amount. Case matters, "ctaz" is not a ticker. */
  ticker: string;
  /** What the toggle's button says. */
  tab: string;
  /** The chain, in the words we would use out loud. */
  chain: string;
  /** Set when the network is not something to rely on. Rendered beside the tab. */
  beta: string | null;
  /**
   * Why a receipt for this network may carry no transaction id. Present for every
   * network, INCLUDING the one that always has one, because the receipt reaches for
   * this only when the id is genuinely absent, and on TAZ that is a bug rather than a
   * property of the chain. A network that should have had an id says so.
   */
  noTxidReason: string;
}

const FACTS: Record<FaucetNetwork, NetworkFacts> = {
  taz: {
    ticker: "TAZ",
    tab: "TAZ",
    chain: "Zcash testnet",
    beta: null,
    // Reached only when a TAZ send came back without an id, which the ledger refuses
    // to record and which means something went wrong on our side. It must not read
    // like the calm cTAZ sentence below.
    noTxidReason: "This drip should have had a transaction id and does not. That is a fault on our side, not a property of the network.",
  },
  ctaz: {
    ticker: "cTAZ",
    tab: "cTAZ",
    chain: "Crosslink feature net",
    // "beta" alone would undersell it. This is a chain running an unreleased consensus
    // change, and someone reaching for it should know that before they build on it.
    beta: "feature net, beta",
    noTxidReason: "This network's faucet returns the amount it paid and no transaction id, so there is nothing to copy and nothing to look up in an explorer.",
  },
};

export function networkFacts(n: FaucetNetwork): NetworkFacts {
  return FACTS[n];
}

/**
 * Read a network off the wire. STRICT: an unrecognised value is null, never the
 * default, so a caller decides for itself whether an absent field and a wrong one
 * deserve the same answer. /api/faucet treats absent as taz (a client older than the
 * toggle) and wrong as a 400 (a client asking for something we do not serve), and it
 * could not tell those apart if this function had defaulted.
 */
export function parseNetwork(raw: unknown): FaucetNetwork | null {
  return raw === "taz" || raw === "ctaz" ? raw : null;
}

/** `0.5 cTAZ`, from zatoshi. Trailing zeros trimmed, because "0.50000000 cTAZ" is noise. */
export function formatAmount(zat: bigint, n: FaucetNetwork): string {
  const whole = zat / 100_000_000n;
  const frac = (zat % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${FACTS[n].ticker}`;
}
