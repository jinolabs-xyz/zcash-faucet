/**
 * Testnet block explorer links. One place, because the same URL was inlined in
 * all four senders and a dead explorer would then need four edits.
 *
 * blockexplorer.one is the one we use: verified serving Zcash testnet
 * transaction pages. Overridable per deploy with FAUCET_EXPLORER_TX_URL, a
 * template containing {txid}, for when that changes and nobody wants to ship
 * code to fix a link.
 */
const DEFAULT_TX_URL = "https://blockexplorer.one/zcash/testnet/tx/{txid}";

export function explorerTxUrl(txid: string): string | undefined {
  if (!txid) return undefined;
  const template = process.env.FAUCET_EXPLORER_TX_URL || DEFAULT_TX_URL;
  return template.replace("{txid}", encodeURIComponent(txid));
}
