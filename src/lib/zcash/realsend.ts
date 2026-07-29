/**
 * Real sender: spends the faucet's funded transparent wallet on testnet.
 *
 * Transparent recipients (tm…): build a real Zcash v4 (Sapling) transaction with
 * @bitgo/utxo-lib — pick UTXOs, add the drip output + change back to ourselves,
 * sign each input (ZIP-243 sighash, handled by the lib), and broadcast via
 * lightwalletd. No zk-proof, so this runs anywhere.
 *
 * Shielded recipients (utest1…/ztestsapling1…): deliberately NOT enabled for
 * real sends. Creating a shielded output needs a zk-proof (t2z-wasm can do it),
 * but its change lands in an Orchard pool this transparent wallet can't
 * re-spend — the faucet would slowly strand its own funds. Enabling shielded
 * properly needs a sweep-capable shielded wallet (Zallet/Z3). See DEPLOY.md.
 */
import type { Sender, SendRequest, SendResult } from "./send.ts";
import { faucetWallet } from "./wallet.ts";
import { getAddressUtxos, getLightdInfo, sendRawTransaction, type Utxo } from "./grpc.ts";
import { tipForExpiry } from "./expiryTip.ts";
import { explorerTxUrl } from "./explorer.ts";

// @bitgo/utxo-lib ships no usable types, so this is any by necessity.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let utxolib: any;
function lib() {
  // Lazy require so the (large) lib only loads when real sends are configured.
  return (utxolib ??= require("@bitgo/utxo-lib"));
}

// Conservative flat fee (ZIP-317's floor for a small transparent tx is well
// under this). 10_000 zatoshi = 0.0001 TAZ.
export const FEE_ZAT = 10_000n;
const ZCASH_SAPLING_VERSION = 4;
const SAPLING_VERSION_GROUP_ID = 0x892f2085;
const SIGHASH_ALL = 0x01;

function explorerUrl(txid: string): string {
  return explorerTxUrl(txid) ?? "";
}

/** Greedily pick UTXOs to cover amount + fee; returns the chosen set + total. */
export function selectInputs(utxos: Utxo[], need: bigint): { chosen: Utxo[]; total: bigint } {
  const chosen: Utxo[] = [];
  let total = 0n;
  for (const u of utxos) {
    chosen.push(u);
    total += u.valueZat;
    if (total >= need) break;
  }
  return { chosen, total };
}

export class RealSender implements Sender {
  readonly name = "real";

  async balance(): Promise<bigint> {
    const utxos = await getAddressUtxos(faucetWallet().address);
    return utxos.reduce((sum, u) => sum + u.valueZat, 0n);
  }

  async send(req: SendRequest): Promise<SendResult> {
    if (req.addressInfo.shielded) {
      throw new Error(
        "Real shielded sends aren't enabled: change would land in a shielded pool this " +
          "transparent faucet can't re-spend (funds would be stranded). Use a transparent " +
          "(tm…) address, or enable shielded via a sweep-capable wallet — see DEPLOY.md.",
      );
    }

    const wallet = faucetWallet();
    const utxos = await getAddressUtxos(wallet.address);
    if (utxos.length === 0) throw new Error("Faucet wallet has no confirmed funds. Top it up.");

    const need = req.amountZat + FEE_ZAT;
    const { chosen, total } = selectInputs(utxos, need);
    if (total < need) {
      throw new Error("Faucet balance too low to cover this drip + fee.");
    }

    // Expiry comes from tipForExpiry (every endpoint, take the max), not from
    // getLatestBlock's first-to-answer. A lagging endpoint that happens to be
    // quick is #190, and stamping its tip builds a transaction that is born
    // expired. Under-estimating kills, over-estimating just buys time.
    const [tip, { info }] = await Promise.all([
      tipForExpiry(),
      getLightdInfo().then((r) => ({ info: r.info })),
    ]);
    const height = tip.height!; // tipForExpiry throws rather than returning null
    const branchId = parseInt(info.consensusBranchId, 16);

    const { hex, txid } = this.buildTransparentTx({
      wallet,
      chosen,
      total,
      toAddress: req.toAddress,
      amountZat: req.amountZat,
      branchId,
      expiryHeight: height + 40, // per t2z/ZIP-203 guidance: current + buffer
    });

    const res = await sendRawTransaction(Buffer.from(hex, "hex"), height);
    if (res.errorCode !== 0) {
      throw new Error(`Broadcast rejected (code ${res.errorCode}): ${res.errorMessage}`);
    }
    return { txid, explorerUrl: explorerUrl(txid) };
  }

  private buildTransparentTx(o: {
    wallet: { priv: Uint8Array; address: string };
    chosen: Utxo[];
    total: bigint;
    toAddress: string;
    amountZat: bigint;
    branchId: number;
    expiryHeight: number;
  }): { hex: string; txid: string } {
    const u = lib();
    const net = u.networks.zcashTest;
    const txb = u.bitgo.createTransactionBuilderForNetwork(net);
    txb.setVersion(ZCASH_SAPLING_VERSION);
    txb.setVersionGroupId(SAPLING_VERSION_GROUP_ID);
    txb.setConsensusBranchId(o.branchId);
    txb.setExpiryHeight(o.expiryHeight);
    txb.setLockTime(0);

    for (const utxo of o.chosen) txb.addInput(utxo.txidBytes, utxo.index);

    txb.addOutput(o.toAddress, Number(o.amountZat));
    const change = o.total - o.amountZat - FEE_ZAT;
    if (change > 0n) txb.addOutput(o.wallet.address, Number(change)); // change back to us (stays spendable)

    const keyPair = u.ECPair.fromPrivateKey(Buffer.from(o.wallet.priv), { network: net });
    o.chosen.forEach((utxo, i) => {
      txb.sign(i, keyPair, undefined, SIGHASH_ALL, Number(utxo.valueZat));
    });

    const tx = txb.build();
    return { hex: tx.toHex(), txid: tx.getId() };
  }
}
