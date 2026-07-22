/**
 * Throwaway TESTNET account generation. Server-side, cryptographically random,
 * NEVER stored or logged (mirrors the Aztec faucet's account tab).
 *
 *   Transparent (REAL, usable now):
 *     secp256k1 keypair → P2PKH → base58check with Zcash testnet version bytes.
 *     Address prefix "tm…"; secret exported as testnet WIF, importable into any
 *     Zcash wallet. Fully derivable in JS, exactly like a Bitcoin key.
 *
 *   Shielded (MOCK for now):
 *     A real BIP39 mnemonic is generated (valid + importable as a seed), but the
 *     unified address is a placeholder — real utest1 derivation needs the WebZjs
 *     WASM lib (wired alongside the real sender). Clearly flagged `mock: true`.
 */
import { randomBytes } from "node:crypto";
import { getPublicKey } from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { base58check as base58checkFactory } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const base58check = base58checkFactory(sha256);

// Zcash TESTNET version bytes.
const TESTNET_P2PKH = Uint8Array.from([0x1d, 0x25]); // "tm…"
const TESTNET_WIF = 0xef; // secret-key prefix (compressed → append 0x01)

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

export interface ThrowawayAccount {
  type: "transparent" | "shielded";
  shielded: boolean;
  address: string;
  /** WIF (transparent) or BIP39 mnemonic (shielded). The user's secret. */
  secret: string;
  secretLabel: string;
  mock: boolean;
  warning: string;
}

function generateTransparent(): ThrowawayAccount {
  // 1. random 32-byte private key valid for secp256k1
  let priv: Uint8Array;
  do {
    priv = new Uint8Array(randomBytes(32));
  } while (!isValidScalar(priv));

  // 2. compressed public key → hash160
  const pub = getPublicKey(priv, true); // compressed 33 bytes
  const pkh = hash160(pub);

  // 3. address = base58check(version || pkh)
  const addrPayload = new Uint8Array(TESTNET_P2PKH.length + pkh.length);
  addrPayload.set(TESTNET_P2PKH, 0);
  addrPayload.set(pkh, TESTNET_P2PKH.length);
  const address = base58check.encode(addrPayload);

  // 4. WIF = base58check(0xEF || priv || 0x01)
  const wifPayload = new Uint8Array(1 + 32 + 1);
  wifPayload[0] = TESTNET_WIF;
  wifPayload.set(priv, 1);
  wifPayload[33] = 0x01; // compressed
  const wif = base58check.encode(wifPayload);

  return {
    type: "transparent",
    shielded: false,
    address,
    secret: wif,
    secretLabel: "Private key (WIF)",
    mock: false,
    warning:
      "Testnet throwaway only. Anyone with this key controls the funds. Not stored by the faucet — copy it now.",
  };
}

function generateShieldedMock(): ThrowawayAccount {
  const mnemonic = generateMnemonic(wordlist, 256); // real 24-word seed
  // Placeholder unified testnet address (NOT spendable) until WASM derivation.
  const filler = base58check
    .encode(new Uint8Array(randomBytes(24)))
    .toLowerCase()
    .replace(/[^023456789acdefghjklmnpqrstuvwxyz]/g, "q")
    .slice(0, 50);
  const address = `utest1${filler}`;
  return {
    type: "shielded",
    shielded: true,
    address,
    secret: mnemonic,
    secretLabel: "Seed phrase (24 words)",
    mock: true,
    warning:
      "MOCK shielded address — not spendable yet. The seed phrase is real; unified address derivation needs the shielded (WASM) tooling.",
  };
}

function isValidScalar(b: Uint8Array): boolean {
  // reject 0 and values >= curve order n (secp256k1)
  const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x > 0n && x < N;
}

export function generateThrowaway(type: "transparent" | "shielded"): ThrowawayAccount {
  return type === "shielded" ? generateShieldedMock() : generateTransparent();
}
