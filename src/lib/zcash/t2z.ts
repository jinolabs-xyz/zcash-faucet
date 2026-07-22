/**
 * Client for the t2z proving worker (workers/t2z-worker.mjs). We spawn the
 * worker by file path at runtime, so the Next.js bundler never sees the wasm —
 * and the ~15–26s CPU-bound proof runs off the server's event loop.
 *
 * Sends are already serialized by the FIFO queue (concurrency 1), so a single
 * worker handling one job at a time is sufficient.
 */
import { Worker } from "node:worker_threads";
import path from "node:path";

let worker: Worker | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  const workerPath = path.join(process.cwd(), "workers", "t2z-worker.mjs");
  worker = new Worker(workerPath);
  worker.on("error", () => {
    worker = null; // let the next send respawn a fresh worker
  });
  worker.on("exit", () => {
    worker = null;
  });
  return worker;
}

/** Spawn + warm the worker (wasm load + proving-key build) at server startup. */
export function warmT2z(): void {
  getWorker();
}

export interface T2zInput {
  pubHex: string;
  txidHex: string; // internal little-endian hex, as lightwalletd returns
  index: number;
  valueZat: bigint;
  scriptHex: string;
}

export function buildT2zTx(o: {
  inputs: T2zInput[];
  recipientUA: string;
  changeTAddr: string;
  faucetPrivHex: string;
  expiryHeight: number;
  dripZat: bigint;
}): Promise<{ hex: string; feeZat: bigint }> {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (m: { ready?: boolean; ok?: boolean; hex?: string; feeZat?: string; error?: string }) => {
      if (m.ready !== undefined) return; // startup warm-up ping, not our result
      cleanup();
      if (m.ok) resolve({ hex: m.hex!, feeZat: BigInt(m.feeZat!) });
      else reject(new Error(m.error ?? "t2z worker failed"));
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      w.off("message", onMessage);
      w.off("error", onError);
    };
    w.on("message", onMessage);
    w.on("error", onError);
    w.postMessage({
      inputs: o.inputs.map((i) => ({
        pubHex: i.pubHex,
        txidHex: i.txidHex,
        index: i.index,
        valueZat: i.valueZat.toString(),
        scriptHex: i.scriptHex,
      })),
      recipientUA: o.recipientUA,
      changeTAddr: o.changeTAddr,
      faucetPrivHex: o.faucetPrivHex,
      expiryHeight: o.expiryHeight,
      dripZat: o.dripZat.toString(),
    });
  });
}
