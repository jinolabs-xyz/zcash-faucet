// Probes a LIVE faucet from outside the box: /api/status and /api/ready only,
// never a claim. The e2e smoke (e2e-smoke.mjs) drains a drip and burns a
// cooldown slot every run, which is right for CI against a throwaway server
// and wrong for production monitoring on a schedule.
//
// The on-box watchdog and metrics timer cannot report a dead box or a broken
// domain. This can, because it runs somewhere else:
//
//   SMOKE_URL=https://faucet.example.org npm run smoke:live
//
// Exit 0 means the faucet is up and ready to drip. Ready saying no is a real
// answer and fails the probe with the app's own reason, because a faucet that
// cannot drip is what monitoring exists to catch. During a planned un-ready
// window (initial sync on a fresh box), set SMOKE_ALLOW_UNREADY=1 to keep the
// schedule green while still failing on unreachable or broken responses.
const BASE = (process.env.SMOKE_URL ?? "").replace(/\/$/, "");
const ALLOW_UNREADY = process.env.SMOKE_ALLOW_UNREADY === "1";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15000);

if (!BASE) {
  console.error("SMOKE_URL is not set, nothing to probe");
  process.exit(2);
}

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "ok" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
};

async function probe(path) {
  const started = Date.now();
  try {
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, body: null, ms: Date.now() - started, err: err.message };
  }
}

const status = await probe("/api/status");
ok("GET /api/status answers 200", status.status === 200, status.err ?? `status ${status.status}, ${status.ms}ms`);
if (status.status !== 200 || !status.body) {
  console.log(`\nlive-probe: ${BASE} is unreachable or broken`);
  process.exit(1);
}
ok("status body is the faucet's", typeof status.body.balanceTaz !== "undefined" && !!status.body.network, `network ${status.body.network}`);
ok("backend reachable from the app", status.body.backend?.reachable === true);
console.log(
  `  balance ${status.body.balanceTaz ?? "unknown"} TAZ` +
    ` · queue ${status.body.queueDepth ?? "?"}` +
    ` · reserve ${status.body.reserve?.refilling ? "topping up" : "ok"}` +
    ` · ${status.ms}ms`,
);

const ready = await probe("/api/ready");
if (ready.status === 200) {
  ok("GET /api/ready says a drip can be served", true, `${ready.ms}ms`);
} else if (ready.status === 503 && ready.body) {
  const reason = ready.body.reason ?? ready.body.error ?? JSON.stringify(ready.body);
  ok("faucet is ready to drip", ALLOW_UNREADY, `app says not ready: ${reason}${ALLOW_UNREADY ? ", allowed by SMOKE_ALLOW_UNREADY" : ""}`);
} else {
  ok("GET /api/ready answers", false, ready.err ?? `status ${ready.status}`);
}

console.log(failures === 0 ? "\nlive-probe: healthy" : `\nlive-probe: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
