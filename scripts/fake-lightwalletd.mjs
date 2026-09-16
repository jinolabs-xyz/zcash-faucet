/**
 * A lightwalletd-shaped backend for the ui job, and it exists because the `ui`
 * check-run has been asking a third party to answer inside the page's budget.
 *
 * WHY THIS EXISTS (#588). `config.ts` falls through to
 * `https://testnet.zec.rocks:443` when LIGHTWALLETD_ENDPOINT is unset, and the ui
 * job never set it - so `pingBackend()` reached the real network on every PR and
 * the index card's phase, and therefore its HEIGHT, followed that call. The
 * CTO's red-team caught it on #576 round two: one fit row read
 * `1440x900 paper /#claim doc 941/900` with a red badge, where main's own run
 * read 900/900 and the identical code re-ran green. A green-or-red job that
 * depends on a stranger's uptime is a flake on every PR, and it had been one.
 *
 * WHY A DOUBLE THAT ANSWERS, RATHER THAN A CLOSED PORT. The obvious fix is to
 * point the variable at a dead port so nothing reaches the network. The repo has
 * already tried that and written down what happened - api-integration.mjs:319:
 *
 *   "Pinning LIGHTWALLETD_ENDPOINT at a closed port to block it is NOT safe: the
 *    same variable is also the app's read-side backend, so breaking it makes
 *    readiness report 'backend unreachable' and fails a different assertion.
 *    Verified by doing exactly that and watching it fail."
 *
 * A closed port does not remove the flake, it makes the FAILING state permanent:
 * "backend unreachable" is precisely the red badge that measured 941 px. So the
 * double answers.
 *
 * WHAT IT HAS TO DO IS SMALL, and worth stating so nobody grows it. `probe()` in
 * lib/zcash/lightwalletd.ts sends a HEAD with a 4 s timeout and treats "did not
 * throw" as reachable. There is no gRPC here to imitate and no body anyone reads.
 *
 * DOWN=true answers nothing, for the case that needs the unreachable state on
 * purpose rather than by accident - the same escape hatch fake-hosh's EMPTY is.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 28612);
// Refuse every request, for a test that wants the backend-unreachable phase
// deliberately. Off by default: the point of this double is a stable healthy read.
const DOWN = process.env.DOWN === "true";

const server = createServer((req, res) => {
  if (DOWN) {
    req.socket.destroy();
    return;
  }
  // HEAD is the only method the app sends. GET answers too so a human can curl it
  // and see that it is up, which is the first thing anyone does when a job is red.
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(req.method === "HEAD" ? undefined : "fake-lightwalletd: up\n");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake-lightwalletd listening on 127.0.0.1:${PORT}${DOWN ? " (DOWN=true, refusing)" : ""}`);
});
