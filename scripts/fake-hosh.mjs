/**
 * A hosh-shaped tip oracle for the integration suite.
 *
 * WHY THIS EXISTS: without it the suite's readiness assertions depend on the
 * public internet, and their outcome is a RACE. The fake wallet reports a node
 * tip of 3,650,000; real testnet is past 4,220,000. So the instant the oracle
 * gets any real answer, the gap is ~570,000 blocks, our node reads as frozen, and
 * server A returns 503 where the suite expects 200. Whether that happens depends
 * on whether externalTip's first background refresh lands before the assertion
 * runs - which is why the same commit passed locally and failed in CI, twice.
 *
 * Pointing HOSH_URL here makes the external tip a value the test chooses. Set
 * HEIGHT to match the wallet double for a healthy stack, or far above it to
 * exercise the frozen path on purpose rather than by accident.
 *
 * Note the fallback matters too: externalTip degrades to a direct lightwalletd
 * call when hosh yields nothing, so a suite that only overrides HOSH_URL can
 * still reach the real network. The suite therefore also points
 * LIGHTWALLETD_ENDPOINT at a closed port.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 28324);
// Matches fake-zallet's NODE_TIP by default, so a healthy stack looks healthy.
const HEIGHT = Number(process.env.HEIGHT ?? 3_650_000);
// Set to serve a payload with no usable testnet entry, so the oracle's
// cannot-verify path is reachable deliberately.
const EMPTY = process.env.EMPTY === "true";

// Shape verified against the live endpoint rather than assumed: the payload is an
// OBJECT with a `servers` array, and only testnet rows carry `chain: "test"` -
// mainnet rows omit the field entirely, which is how fromHosh's filter separates
// them. A bare array here silently matched nothing, so the oracle fell back to a
// direct lightwalletd call and cached the real network tip, which is the exact
// failure this fixture exists to remove. Getting the double's shape wrong made the
// suite deterministic for the wrong reason.
const body = () =>
  JSON.stringify({
    servers: EMPTY
      ? []
      : [
          {
            hostname: "testnet.fake.local",
            port: 443,
            protocol: "grpc",
            online: true,
            chain: "test",
            height: HEIGHT,
            uptime_30d: 1,
            node_version: "Zebra:6.2.2",
            lightwallet_server_version: "v0.5.1",
          },
          // A mainnet row, so the filter is genuinely exercised rather than
          // trivially matching the only entry. No `chain` field, as in the real
          // payload.
          {
            hostname: "mainnet.fake.local",
            port: 443,
            protocol: "grpc",
            online: true,
            height: 3_000_000,
            uptime_30d: 1,
          },
        ],
  });

createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body());
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`fake-hosh: :${PORT} height=${EMPTY ? "none" : HEIGHT}\n`);
});
