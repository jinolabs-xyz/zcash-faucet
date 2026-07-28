/**
 * The faucet's own TESTNET transparent identity, derived from FAUCET_WALLET_SEED.
 *
 * The seed is either a testnet WIF (what the Account tab hands out, prefix
 * byte 0xEF) or a raw 64-hex private key. We keep this transparent on purpose:
 * a t-address is trivially fundable from any existing faucet, its UTXOs are
 * queryable, and spending needs no zk-proof — which is what makes real sends
 * work on a small box with only a public lightwalletd endpoint.
 */
import { getPublicKey } from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58check as base58checkFactory } from "@scure/base";
import { config } from "../config.ts";

const base58check = base58checkFactory(sha256);
const TESTNET_P2PKH = Uint8Array.from([0x1d, 0x25]);
const TESTNET_WIF = 0xef;

export interface FaucetWallet {
  priv: Uint8Array;
  pubHex: string; // compressed pubkey
  address: string; // tm…
  scriptHex: string; // P2PKH scriptPubKey
}

function hash160(d: Uint8Array): Uint8Array {
  return ripemd160(sha256(d));
}

let cached: FaucetWallet | null = null;

export function faucetWallet(): FaucetWallet {
  if (cached) return cached;

  const seed = config.walletSeed.trim();
  if (!seed) throw new Error("FAUCET_WALLET_SEED is required for real sends.");

  let priv: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(seed)) {
    priv = hexToBytes(seed);
  } else {
    // testnet WIF: base58check(0xEF || priv[32] || [0x01 if compressed])
    let decoded: Uint8Array;
    try {
      decoded = base58check.decode(seed);
    } catch {
      throw new Error("FAUCET_WALLET_SEED is neither a 64-hex key nor a valid WIF.");
    }
    if (decoded[0] !== TESTNET_WIF) {
      throw new Error("FAUCET_WALLET_SEED WIF is not a testnet key (expected 0xEF prefix).");
    }
    priv = decoded.slice(1, 33);
  }

  const pub = getPublicKey(priv, true); // compressed
  const pkh = hash160(pub);
  const address = base58check.encode(new Uint8Array([...TESTNET_P2PKH, ...pkh]));
  const scriptHex = `76a914${bytesToHex(pkh)}88ac`; // OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG

  cached = { priv, pubHex: bytesToHex(pub), address, scriptHex };
  return cached;
}
