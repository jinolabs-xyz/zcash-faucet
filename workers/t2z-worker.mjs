/**
 * t2z proving worker (plain Node, run via worker_thread — deliberately OUTSIDE
 * src/ so the Next.js bundler never touches the wasm). Loads @d4mr/t2z-wasm via
 * the bundler-target shim, builds a transparent→Orchard tx, and returns the raw
 * tx hex. Proving (~15–26s, CPU-bound) happens here, off the server event loop.
 *
 * Protocol: parent postMessage({inputs, recipientUA, changeTAddr, faucetPrivHex,
 * expiryHeight, dripZat}) → worker postMessage({ok, hex, feeZat} | {ok:false, error}).
 * Amounts cross the boundary as strings (belt-and-suspenders around BigInt).
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
  if (!mod.is_proving_key_ready()) mod.prebuild_proving_key(); // ~11s, once
  bg = mod;
  return bg;
}

// Warm the wasm + proving key as soon as the worker starts.
load().then(
  () => parentPort?.postMessage({ ready: true }),
  (e) => parentPort?.postMessage({ ready: false, error: String(e?.message ?? e) }),
);

parentPort?.on("message", async (job) => {
  try {
    const t = await load();
    const inputs = job.inputs.map(
      (i) => new t.WasmTransparentInput(i.pubHex, i.txidHex, i.index, BigInt(i.valueZat), i.scriptHex, null),
    );
    const payment = new t.WasmPayment(job.recipientUA, BigInt(job.dripZat), null, null);

    let pczt = t.propose_transaction(inputs, [payment], job.changeTAddr, "testnet", job.expiryHeight);

    const info = t.inspect_pczt(pczt.to_hex());
    const feeZat = BigInt(info.implied_fee);
    const totalIn = job.inputs.reduce((s, i) => s + BigInt(i.valueZat), 0n);
    if (totalIn < BigInt(job.dripZat) + feeZat) {
      throw new Error("Selected inputs don't cover drip + fee.");
    }

    job.inputs.forEach((_, i) => {
      pczt = t.sign_transparent_input(pczt, i, job.faucetPrivHex);
    });
    pczt = t.prove_transaction(pczt);
    const hex = t.finalize_and_extract_hex(pczt);

    parentPort?.postMessage({ ok: true, hex, feeZat: feeZat.toString() });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: String(e?.message ?? e) });
  }
});
