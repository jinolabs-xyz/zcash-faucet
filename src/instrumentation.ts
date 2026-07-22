/**
 * Next.js startup hook. In real mode we spawn + warm the t2z proving worker at
 * boot (loads the wasm and builds the Halo2 proving key, ~11s) so the first
 * shielded send isn't penalised by a cold key build.
 */
export async function register() {
  // Node runtime only (skip Edge), and only when real sends are configured.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if ((process.env.FAUCET_SENDER ?? "mock") !== "real") return;
  const { warmT2z } = await import("@/lib/zcash/t2z");
  warmT2z();
}
