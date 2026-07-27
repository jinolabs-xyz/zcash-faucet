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

  // Boot-time config validation (reserve levels, RATE_LIMIT_SALT guard) throws
  // on fatal misconfig. Without this catch Next swallows the throw, keeps the
  // port open, and 500s every request, a zombie the watchdog can only ping
  // forever. Exit instead: the process dies visibly and supervision restarts
  // it once the operator fixes the env.
  try {
    await import("@/lib/config");
  } catch (err) {
    console.error(`[boot] fatal config error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const { getReserveReconciler } = await import("@/lib/reserve/reconciler");
  getReserveReconciler().start();

  if ((process.env.FAUCET_SENDER ?? "mock") !== "real") return;
  const { warmT2z } = await import("@/lib/zcash/t2z");
  warmT2z();
}
