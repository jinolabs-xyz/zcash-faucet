/**
 * Draining: the process has been told to stop and is letting in-flight sends finish.
 *
 * Every merge recreates the container, and compose stops the old one with SIGTERM.
 * Next's default handler exits at once, so a z_sendmany that was mid-flight was
 * broadcast by the wallet and forgotten by us: no receipt for the visitor, a pending
 * row that expires with its lease, and the same address paid again a retry later
 * (risk register II, R-27). With NEXT_MANUAL_SIG_HANDLE set, register() owns the
 * signal instead: it flips this flag so the claim route refuses NEW work with a 503
 * the page renders as "our side, not yours", waits for the send queues to empty, then
 * exits. The wait is bounded, and the bound has to sit under compose's
 * stop_grace_period or docker's SIGKILL wins and nothing here matters.
 */
// ON globalThis, like the send queue: Next bundles instrumentation.ts and the route
// handlers separately, so a module-level `let` here is two variables, and the route
// kept answering as if nothing were draining while the signal handler waited on a
// flag nobody read. Measured before this was moved.
const g = globalThis as unknown as { __faucetDraining?: boolean };

export function isDraining(): boolean {
  return g.__faucetDraining === true;
}

/** How long a claim refused for draining should wait before trying again. A recreate
 * is seconds of stop plus seconds of start; the page counts this down on its button. */
export const DRAIN_RETRY_SECONDS = 20;

/**
 * Mark the process draining and resolve once every queue is empty or the bound has
 * passed. Returns whether the queues actually emptied, so the caller can log which.
 */
export async function drain(depth: () => number, boundMs: number, everyMs = 250): Promise<boolean> {
  g.__faucetDraining = true;
  const until = Date.now() + boundMs;
  while (depth() > 0) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return true;
}

/** Test seam. */
export function resetDrainForTests(): void {
  g.__faucetDraining = false;
}
