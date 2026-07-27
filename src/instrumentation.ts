/**
 * Next.js startup hook. In real mode we spawn + warm the t2z proving worker at
 * boot (loads the wasm and builds the Halo2 proving key, ~11s) so the first
 * shielded send isn't penalised by a cold key build.
 *
 * Also the one place that arms the reserve reconciler — status polls read its
 * state but never start it. start() is a no-op until FAUCET_MINER_ACTIVE.
 */
export async function register() {
  // Node runtime only (skip Edge).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getReserveReconciler } = await import("@/lib/reserve/reconciler");
  getReserveReconciler().start();

  if ((process.env.FAUCET_SENDER ?? "mock") !== "real") return;
  const { warmT2z } = await import("@/lib/zcash/t2z");
  warmT2z();
}
