/**
 * Testnet block explorer links. One place, because the same URL was inlined in
 * all four senders and a dead explorer would then need four edits.
 *
 * testnet.cipherscan.app is the one we use. It passes the check blockexplorer.one
 * failed (#71): a real txid renders its block and confirmations, and an unknown
 * txid returns 404 rather than decorating any 64-hex string as if it existed, so
 * the link actually confirms rather than reassures. The node-truth /api/tx is
 * still the authority; this is the human-readable courtesy link. Overridable per
 * deploy with FAUCET_EXPLORER_TX_URL, a template containing {txid}.
 */
const DEFAULT_TX_URL = "https://testnet.cipherscan.app/tx/{txid}";

export function explorerTxUrl(txid: string): string | undefined {
  if (!txid) return undefined;
  const template = process.env.FAUCET_EXPLORER_TX_URL || DEFAULT_TX_URL;
  return template.replace("{txid}", encodeURIComponent(txid));
}
