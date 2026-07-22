/**
 * Shielded sender: pays a unified (Orchard) recipient by spending the faucet's
 * transparent UTXOs via t2z. Change returns to the faucet's own t-address, so
 * funds re-circulate — see ./t2z.ts for why that matters.
 */
import type { Sender, SendRequest, SendResult } from "./send";
import { faucetWallet } from "./wallet";
import { getAddressUtxos, getLatestBlock, sendRawTransaction, type Utxo } from "./grpc";
import { buildT2zTx } from "./t2z";
import { bytesToHex } from "@noble/hashes/utils.js";

// Fee is read from the PCZT before proving; this is only a selection cushion so
// we grab enough UTXOs. The real (implied) fee is enforced in buildT2zTx.
const FEE_CUSHION_ZAT = 20_000n;

/** Compute the v5 (NU5) txid from the finalized hex for the explorer link. */
function txidFromHex(hex: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const u = require("@bitgo/utxo-lib");
    const tx = u.bitgo.createTransactionFromHex(hex, u.networks.zcashTest);
    return tx.getId();
  } catch {
    return ""; // best-effort; broadcast still succeeds, link is just omitted
  }
}

export class T2zSender implements Sender {
  readonly name = "t2z";

  async balance(): Promise<bigint> {
    const utxos = await getAddressUtxos(faucetWallet().address);
    return utxos.reduce((sum, u) => sum + u.valueZat, 0n);
  }

  async send(req: SendRequest): Promise<SendResult> {
    const wallet = faucetWallet();
    const utxos = await getAddressUtxos(wallet.address);
    if (utxos.length === 0) throw new Error("Faucet wallet has no confirmed funds. Top it up.");

    const need = req.amountZat + FEE_CUSHION_ZAT;
    const chosen: Utxo[] = [];
    let total = 0n;
    for (const u of utxos) {
      chosen.push(u);
      total += u.valueZat;
      if (total >= need) break;
    }
    if (total < need) throw new Error("Faucet balance too low to cover this drip + fee.");

    const height = Number((await getLatestBlock()).height);

    const { hex } = await buildT2zTx({
      inputs: chosen.map((u) => ({
        pubHex: wallet.pubHex,
        txidHex: u.txid,
        index: u.index,
        valueZat: u.valueZat,
        scriptHex: u.script,
      })),
      recipientUA: req.toAddress,
      changeTAddr: wallet.address, // change back to us, stays spendable
      faucetPrivHex: bytesToHex(wallet.priv),
      expiryHeight: height + 40,
      dripZat: req.amountZat,
    });

    const res = await sendRawTransaction(Buffer.from(hex, "hex"), height);
    if (res.errorCode !== 0) {
      throw new Error(`Broadcast rejected (code ${res.errorCode}): ${res.errorMessage}`);
    }

    const txid = txidFromHex(hex);
    return {
      txid,
      explorerUrl: txid ? `https://blockexplorer.one/zcash/testnet/tx/${txid}` : undefined,
    };
  }
}
