/**
 * Zcash TESTNET address validation, byte-accurate.
 *
 * Supported testnet formats (2026 / NU6-era):
 *   - Unified Address (preferred):   utest1...        (bech32m)
 *   - Sapling shielded:              ztestsapling1... (bech32)
 *   - Transparent P2PKH:             tm...            (base58check)
 *   - Transparent P2SH:              t2...            (base58check)
 *
 * Checks run cheapest first: prefix and length bounds give friendly reasons
 * for typos and mainnet paste-os, then the real decode verifies the checksum
 * and payload bytes, so a single mistyped character cannot send coins to an
 * address nobody controls. Unified receivers are checksum-validated but not
 * parsed further (F4Jumble + typecode walk); the wallet rejects anything
 * unpayable at send time.
 */
import { base58check as base58checkFactory, bech32, bech32m } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

export type AddressKind = "unified" | "sapling" | "transparent";

export interface AddressInfo {
  valid: boolean;
  kind?: AddressKind;
  shielded?: boolean;
  reason?: string;
}

const base58check = base58checkFactory(sha256);

// Zcash testnet two-byte version prefixes (protocol spec 5.6.1.1). These are
// what makes the base58 encoding come out as "tm..." / "t2...".
const P2PKH_VERSION: readonly number[] = [0x1d, 0x25]; // tm
const P2SH_VERSION: readonly number[] = [0x1c, 0xba]; // t2

// bech32's default 90-char cap predates Zcash-sized payloads. Sapling
// addresses run ~78 data chars plus HRP and unified ones far longer, so
// decode with an explicit generous limit.
const BECH32_LIMIT = 1023;

function decodeBech32(addr: string, variant: typeof bech32 | typeof bech32m) {
  const { prefix, words } = variant.decode(addr as `${string}1${string}`, BECH32_LIMIT);
  return { prefix, bytes: variant.fromWords(words) };
}

export function validateTestnetAddress(input: string): AddressInfo {
  const addr = input.trim();
  if (!addr) return { valid: false, reason: "Address is empty." };
  if (addr.length > 512) return { valid: false, reason: "Address is too long." };

  // Reject obvious mainnet addresses early for a clearer error.
  if (/^(u1|zs|t1|t3)/.test(addr)) {
    return { valid: false, reason: "That looks like a MAINNET address. This faucet only funds testnet." };
  }

  // Unified, testnet (utest1...) or regtest (uregtest1...): bech32m.
  const uniPrefix = ["utest1", "uregtest1"].find((p) => addr.toLowerCase().startsWith(p));
  if (uniPrefix) {
    let bytes: Uint8Array;
    try {
      ({ bytes } = decodeBech32(addr, bech32m));
    } catch {
      return { valid: false, reason: "Malformed unified address (bad bech32m checksum). Re-copy it from your wallet." };
    }
    // Smallest real UA (one Orchard receiver + F4Jumble padding) is ~59 bytes.
    if (bytes.length < 48) {
      return { valid: false, reason: "Malformed unified address (payload too short)." };
    }
    return { valid: true, kind: "unified", shielded: true };
  }

  // Sapling, testnet (ztestsapling1...) or regtest (zregtestsapling1...): bech32.
  const sapPrefix = ["ztestsapling1", "zregtestsapling1"].find((p) => addr.toLowerCase().startsWith(p));
  if (sapPrefix) {
    let bytes: Uint8Array;
    try {
      ({ bytes } = decodeBech32(addr, bech32));
    } catch {
      return { valid: false, reason: "Malformed Sapling address (bad bech32 checksum). Re-copy it from your wallet." };
    }
    // A Sapling payment address is exactly 11 diversifier + 32 pk_d bytes.
    if (bytes.length !== 43) {
      return { valid: false, reason: "Malformed Sapling address (wrong payload size)." };
    }
    return { valid: true, kind: "sapling", shielded: true };
  }

  // Transparent testnet: tm... (P2PKH) or t2... (P2SH), base58check.
  if (/^(tm|t2)/.test(addr)) {
    let payload: Uint8Array;
    try {
      payload = base58check.decode(addr);
    } catch {
      return { valid: false, reason: "Malformed transparent address (bad base58check checksum). Retype or re-copy it." };
    }
    // 2 version bytes + 20-byte hash160.
    const version = addr.startsWith("tm") ? P2PKH_VERSION : P2SH_VERSION;
    if (payload.length !== 22 || payload[0] !== version[0] || payload[1] !== version[1]) {
      return { valid: false, reason: "Malformed transparent address (wrong version or payload size)." };
    }
    return { valid: true, kind: "transparent", shielded: false };
  }

  return {
    valid: false,
    reason: "Unrecognized address. Use utest1… (unified), ztestsapling1… (Sapling), or tm…/t2… (transparent).",
  };
}
