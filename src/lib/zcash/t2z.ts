/**
 * Client for the t2z worker (workers/t2z-worker.mjs). Spawns the worker by file
 * path at runtime so the bundler never sees the wasm, and runs the ~15–26s proof
 * off the server event loop. Requests are id-correlated, so a quick account-gen
 * can be answered while a send is still proving.
 */
import { Worker } from "node:worker_threads";
import path from "node:path";

let worker: Worker | null = null;
let seq = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(path.join(process.cwd(), "workers", "t2z-worker.mjs"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  w.on("message", (m: any) => {
    if (typeof m?.id !== "number") return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m);
    else p.reject(new Error(m.error ?? "t2z worker error"));
  });
  const fail = (e: unknown) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    worker = null; // next call respawns
  };
  w.on("error", fail);
  w.on("exit", () => fail(new Error("t2z worker exited")));
  worker = w;
  return w;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(job: Record<string, any>): Promise<any> {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...job, id });
  });
}

/** Spawn + warm the worker (build the proving key) at server startup. */
export function warmT2z(): void {
  call({ type: "warm" }).catch(() => {});
}

/** Mint a real testnet Orchard account (address + spending key). */
export async function generateShieldedAccount(): Promise<{
  address: string;
  spendingKey: string;
  fvk: string;
}> {
  const m = await call({ type: "keypair" });
  return m.keypair;
}

export interface T2zInput {
  pubHex: string;
  txidHex: string; // internal little-endian hex, as lightwalletd returns
  index: number;
  valueZat: bigint;
  scriptHex: string;
}

export async function buildT2zTx(o: {
  inputs: T2zInput[];
  recipientUA: string;
  changeTAddr: string;
  faucetPrivHex: string;
  expiryHeight: number;
  dripZat: bigint;
}): Promise<{ hex: string; feeZat: bigint }> {
  const m = await call({
    type: "send",
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
  return { hex: m.hex, feeZat: BigInt(m.feeZat) };
}
