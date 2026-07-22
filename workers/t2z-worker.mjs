/**
 * t2z worker (plain Node, run via worker_thread — deliberately OUTSIDE src/ so
 * the Next.js bundler never touches the wasm). Handles three job types, each
 * tagged with an `id` so several can be in flight without their replies crossing:
 *   - warm     : build the Halo2 proving key (~11s), so the first send is fast
 *   - keypair  : mint a real testnet Orchard account (address + spending key)
 *   - send     : build → sign → prove → finalize a transparent→Orchard tx
 *
 * Proving (~15–26s, CPU-bound) runs here, off the server event loop.
 */
import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let bg = null;

async function load() {
  if (bg) return bg;
  const require = createRequire(import.meta.url);
  const bgPath = require.resolve("@d4mr/t2z-wasm/t2z_wasm_bg.js");
  const wasmPath = bgPath.replace(/t2z_wasm_bg\.js$/, "t2z_wasm_bg.wasm");
  const mod = await import(bgPath);
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
    "./t2z_wasm_bg.js": mod,
  });
  mod.__wbg_set_wasm(instance.exports);
  instance.exports.__wbindgen_start?.();
  bg = mod;
  return bg;
}

parentPort?.on("message", async (job) => {
  const { id, type } = job;
  try {
    const t = await load();

    if (type === "warm") {
      if (!t.is_proving_key_ready()) t.prebuild_proving_key();
      parentPort.postMessage({ id, ok: true });
      return;
    }

    if (type === "keypair") {
      const kp = t.generate_test_keypair("testnet");
      parentPort.postMessage({
        id,
        ok: true,
        keypair: {
          address: kp.address,
          spendingKey: kp.spending_key,
          fvk: kp.full_viewing_key_hex ?? kp.full_viewing_key ?? "",
        },
      });
      return;
    }

    if (type === "send") {
      const inputs = job.inputs.map(
        (i) => new t.WasmTransparentInput(i.pubHex, i.txidHex, i.index, BigInt(i.valueZat), i.scriptHex, null),
      );
      const payment = new t.WasmPayment(job.recipientUA, BigInt(job.dripZat), null, null);
      let pczt = t.propose_transaction(inputs, [payment], job.changeTAddr, "testnet", job.expiryHeight);

      const info = t.inspect_pczt(pczt.to_hex());
      const feeZat = BigInt(info.implied_fee);
      const totalIn = job.inputs.reduce((s, i) => s + BigInt(i.valueZat), 0n);
      if (totalIn < BigInt(job.dripZat) + feeZat) throw new Error("Selected inputs don't cover drip + fee.");

      job.inputs.forEach((_, i) => {
        pczt = t.sign_transparent_input(pczt, i, job.faucetPrivHex);
      });
      pczt = t.prove_transaction(pczt);
      const hex = t.finalize_and_extract_hex(pczt);
      parentPort.postMessage({ id, ok: true, hex, feeZat: feeZat.toString() });
      return;
    }

    parentPort.postMessage({ id, ok: false, error: `unknown job type: ${type}` });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
});
