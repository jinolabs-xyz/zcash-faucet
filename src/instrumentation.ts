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

  // Farming visibility (#196). Its own slow timer rather than a route, because these
  // figures must NOT be public: claim volume is not otherwise observable now that
  // drips are shielded, and a distinct-IP count tells a farmer how many identities we
  // currently see, which is direct feedback for tuning an attack. A log line reaches
  // the operator and nobody else, needs no auth we do not have, and changes no shared
  // surface. Putting it on /api/status is a shared-surface AND an opsec decision, so
  // it is not mine to make quietly.
  //
  // Ten minutes: farming is a shape that emerges over hours, and a tighter interval
  // would spend a ledger scan to re-learn the same number.
  const { farmingSignals } = await import("@/lib/db");
  const emitSignals = async () => {
    const s = await farmingSignals(Math.floor(Date.now() / 1000));
    if (!s) {
      // Not zeros. Zeros read as a quiet faucet, which is the #172 mistake in a new
      // place: "we could not look" and "nobody claimed" must not print the same.
      console.error("[farming] signals UNAVAILABLE: the ledger read failed, so these counts are unknown rather than zero");
      return;
    }
    console.log(
      `[farming] 1h claims=${s.claims1h} ips=${s.distinctIps1h} addrs=${s.distinctAddrs1h} taz=${s.taz1h.toFixed(1)} | ` +
        `24h claims=${s.claims24h} ips=${s.distinctIps24h} addrs=${s.distinctAddrs24h} taz=${s.taz24h.toFixed(1)} | ` +
        `claims_per_ip_24h=${s.claimsPerIp24h === null ? "n/a" : s.claimsPerIp24h.toFixed(2)} | ` +
        // Named as absent rather than omitted, so nobody reads its absence as a zero.
        "subnet_spread=UNAVAILABLE(no subnet_hash column yet, #213)",
    );
  };
  const signalsTimer = setInterval(() => void emitSignals(), 10 * 60_000);
  signalsTimer.unref(); // never keep the process alive for a diagnostic
  void emitSignals(); // one at boot, so a restart does not blind us for ten minutes

  // Warm the independent tip cache so the first readiness check can already tell
  // whether our node is following the chain (#170). Fire-and-forget: never block
  // boot on a public endpoint.
  const { warmExternalTip } = await import("@/lib/zcash/externalTip");
  void warmExternalTip();

  if (process.env.FAUCET_SENDER !== "real") return;
  const { warmT2z } = await import("@/lib/zcash/t2z");
  warmT2z();
}
