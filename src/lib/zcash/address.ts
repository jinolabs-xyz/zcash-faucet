/**
 * Zcash TESTNET address validation.
 *
 * Supported testnet formats (2026 / NU6-era):
 *   - Unified Address (preferred):   utest1...        (bech32m)
 *   - Sapling shielded:              ztestsapling1... (bech32)
 *   - Transparent P2PKH:             tm...            (base58check)
 *   - Transparent P2SH:              t2...            (base58check)
 *
 * This does prefix + charset + length checks — enough to reject typos and
 * mainnet addresses. For byte-accurate validation (checksum / HRP decode)
 * wire in a bech32m + base58check decoder; noted inline below.
 */

export type AddressKind = "unified" | "sapling" | "transparent";

export interface AddressInfo {
  valid: boolean;
  kind?: AddressKind;
  shielded?: boolean;
  reason?: string;
}

const BECH32_CHARSET = /^[023456789acdefghjklmnpqrstuvwxyz]+$/; // bech32/bech32m data charset
const BASE58_CHARSET = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

export function validateTestnetAddress(input: string): AddressInfo {
  const addr = input.trim();
  if (!addr) return { valid: false, reason: "Address is empty." };
  if (addr.length > 512) return { valid: false, reason: "Address is too long." };

  // Reject obvious mainnet addresses early for a clearer error.
  if (/^(u1|zs|t1|t3)/.test(addr)) {
    return { valid: false, reason: "That looks like a MAINNET address. This faucet only funds testnet." };
  }

  // Unified testnet: utest1<data>
  if (addr.startsWith("utest1")) {
    const data = addr.slice("utest1".length).toLowerCase();
    if (data.length < 8 || !BECH32_CHARSET.test(data)) {
      return { valid: false, reason: "Malformed unified address." };
    }
    // TODO: bech32m-decode to verify checksum + receiver typecodes.
    return { valid: true, kind: "unified", shielded: true };
  }

  // Sapling testnet: ztestsapling1<data>, canonical length ~78 chars total.
  if (addr.startsWith("ztestsapling1")) {
    const data = addr.slice("ztestsapling1".length).toLowerCase();
    if (data.length < 32 || !BECH32_CHARSET.test(data)) {
      return { valid: false, reason: "Malformed Sapling address." };
    }
    // TODO: bech32-decode to verify checksum.
    return { valid: true, kind: "sapling", shielded: true };
  }

  // Transparent testnet: tm... (P2PKH) or t2... (P2SH), base58check, 35 chars.
  if (/^(tm|t2)/.test(addr)) {
    if (addr.length < 34 || addr.length > 36 || !BASE58_CHARSET.test(addr)) {
      return { valid: false, reason: "Malformed transparent address." };
    }
    // TODO: base58check-decode to verify the 4-byte checksum + version bytes.
    return { valid: true, kind: "transparent", shielded: false };
  }

  return {
    valid: false,
    reason: "Unrecognized address. Use utest1… (unified), ztestsapling1… (Sapling), or tm…/t2… (transparent).",
  };
}
