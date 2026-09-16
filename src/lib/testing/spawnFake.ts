/**
 * Spawn one of the scripts/fake-*.mjs doubles on a KERNEL-PICKED port and hand back the port it
 * actually got (#603).
 *
 * WHY THIS EXISTS. A unit test that binds a fixed port does not fail when the port is taken -- it
 * reports a WRONG VALUE. The spawn loses the bind, the test's own fetch reaches whoever IS
 * listening, and the assertion fails with a plausible number from a stranger's double. On
 * 2026-09-16 `send.test.ts` asserted 100000000n and got 1500000000n because another process held
 * 28451, and three people nearly published that red as a code defect. `crosslinksend.test.ts` bound
 * 28611, which is also ui-smoke's lightwalletd double.
 *
 * The in-process doubles solved this with `listen(0)` (#501). These are CHILD processes, so the
 * child does the binding and the port has to come back out: the fakes print the port they are bound
 * to, and this reads that line. Asking the kernel for a free port in the parent and passing it down
 * would race -- something else can take it between the close and the child's listen.
 *
 * FAILS LOUDLY BY DESIGN. If the child dies or never announces, this rejects with whatever it
 * printed instead. The whole point is that a port problem must not arrive disguised as an
 * assertion about business logic.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface Fake {
  proc: ChildProcess;
  port: number;
  /** Kills the child and its group. Safe to call twice. */
  stop(): void;
}

const ANNOUNCE = /127\.0\.0\.1:(\d+)/;

export async function spawnFake(
  script: string,
  env: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<Fake> {
  const proc = spawn("node", [script], {
    // PORT=0 asks the kernel. An explicit PORT in `env` still wins, so a caller that genuinely
    // needs a known port keeps the old behaviour rather than being silently overridden.
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const stop = () => {
    try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already gone */ }
  };

  let out = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`${script} did not announce a port in ${timeoutMs}ms; it printed: ${out.trim() || "(nothing)"}`));
    }, timeoutMs);
    const look = (chunk: Buffer) => {
      out += String(chunk);
      const m = ANNOUNCE.exec(out);
      if (!m) return;
      const p = Number(m[1]);
      // A fake that announced :0 is one whose listen callback prints the REQUESTED port rather
      // than the bound one. That is the bug this helper's contract depends on not existing, so it
      // is refused here rather than handed back as a port nothing is listening on.
      if (!p) return;
      clearTimeout(timer);
      resolve(p);
    };
    proc.stdout?.on("data", look);
    proc.stderr?.on("data", look);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      stop();
      reject(new Error(`${script} exited with ${code} before announcing a port; it printed: ${out.trim() || "(nothing)"}`));
    });
  });

  return { proc, port, stop };
}
