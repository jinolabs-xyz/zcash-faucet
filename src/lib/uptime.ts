/**
 * How long THIS PROCESS has been running, so "did it restart" is something a reader can
 * see rather than something they have to infer.
 *
 * WHY IT EXISTS. On 2026-09-15 a deploy was reported stalled for an hour on the strength of
 * `reserve.blindTicks` climbing 3 -> 45 -> 59 with no reset. The counter is per-process and
 * does reset on a restart, so the reading looked sound - and it was wrong, because the
 * counter ticks every 30 s while the samples were two minutes apart and the container swap
 * takes about ten. Three restarts hid in the gaps. The journal had the answer from the
 * first minute; the owner stopped the deploy timer before anyone read it.
 *
 * The fix is not a better counter. It is that a process should say how old it is, in one
 * public field, so nobody has to know another field's tick rate to answer a different
 * question with it.
 *
 * FROM process.uptime(), NOT A MODULE-LEVEL TIMESTAMP, and that is not a style choice: Next
 * hands instrumentation and the route handlers different instances of a module (#234, and
 * the same trap is documented in db/index.ts, queue.ts, sendHealth.ts, crosslink/cache.ts
 * and externalTip.ts). A `const startedAt = Date.now()` at module scope would be a
 * different value in each instance, so the answer would depend on which one served the
 * request. The process's own clock has no instances.
 */
export interface UptimeReading {
  /** Whole seconds since this process started. Floored, never rounded: a process 59.9 s
   *  old has not been up for a minute. */
  uptimeSeconds: number;
  /** The moment it started, ISO. Operator-only, because it is the exact figure and the
   *  public one is deliberately coarse-grained by being an integer count. */
  startedAt: string;
}

/**
 * Pure, so both properties worth testing are reachable without a clock: the count rises
 * with uptime, and it FALLS when the process is replaced. A test that could only read the
 * real `process.uptime()` could assert neither, since the test runner's own process has
 * been up for as long as the suite has.
 */
export function uptimeReading(processUptimeSeconds: number, nowMs: number): UptimeReading {
  // Negative is not reachable from process.uptime(), and clamping rather than trusting it
  // costs nothing: a negative age on a status page would be read as a bug in the box.
  const seconds = Math.max(0, processUptimeSeconds);
  return {
    uptimeSeconds: Math.floor(seconds),
    // Computed from the UNROUNDED uptime: the operator's figure should not inherit the
    // public one's flooring, or two fields that describe the same instant would disagree
    // by up to a second.
    startedAt: new Date(nowMs - seconds * 1000).toISOString(),
  };
}
