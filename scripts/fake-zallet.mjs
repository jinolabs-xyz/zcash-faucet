// A tiny fake Zallet JSON-RPC wallet for local testing of sync-dependent
// flows, above all the queued-claim UX: the real mock sender can never be
// "syncing", so this simulates the one transition that feature is about.
//
//   node scripts/fake-zallet.mjs            # sync completes after 20s
//   SYNC_SECONDS=45 node scripts/fake-zallet.mjs
//
// Point the app at it:
//   FAUCET_SENDER=zallet ZALLET_RPC_URL=http://127.0.0.1:28299/ \
//   ZALLET_ACCOUNT=fake-account ZALLET_ADDRESS=utest1fake PORT=3100 npm start
//
// getwalletstatus ramps wallet_tip toward node_tip over SYNC_SECONDS, then
// reports synced. Balance is a healthy constant, sends succeed instantly with
// a fake txid. Nothing here talks to any chain.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 28299);
const SYNC_SECONDS = Number(process.env.SYNC_SECONDS ?? 20);
const NODE_TIP = 3_650_000;
const started = Date.now();

const ops = new Map(); // opid -> txid

function walletTip() {
  const frac = Math.min(1, (Date.now() - started) / (SYNC_SECONDS * 1000));
  // Start 5000 blocks behind so syncPercent moves visibly, land exactly on tip.
  return NODE_TIP - Math.round(5000 * (1 - frac));
}

const handlers = {
  getwalletstatus: () => ({ wallet_tip: { height: walletTip() }, node_tip: { height: NODE_TIP } }),
  z_getbalanceforaccount: () => ({ pools: { orchard: { valueZat: 15_0000_0000 } } }),
  walletpassphrase: () => null,
  z_sendmany: () => {
    const opid = "opid-fake-" + randomBytes(4).toString("hex");
    ops.set(opid, randomBytes(32).toString("hex"));
    return opid;
  },
  z_shieldcoinbase: () => ({ remainingUTXOs: 0 }),
  z_getoperationstatus: (params) => [{ id: params[0][0], status: "success" }],
  z_getoperationresult: (params) => {
    const opid = params[0][0];
    return [{ id: opid, status: "success", result: { txid: ops.get(opid) ?? randomBytes(32).toString("hex") } }];
  },
};

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let out;
    try {
      const { method, params } = JSON.parse(body);
      const handler = handlers[method];
      out = handler
        ? { jsonrpc: "2.0", result: handler(params ?? []) }
        : { jsonrpc: "2.0", error: { code: -32601, message: `fake-zallet: no handler for ${method}` } };
      console.log(`${method} -> ${handler ? "ok" : "unhandled"}${method === "getwalletstatus" ? ` (tip ${walletTip()}/${NODE_TIP})` : ""}`);
    } catch {
      out = { jsonrpc: "2.0", error: { code: -32700, message: "parse error" } };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`fake-zallet on 127.0.0.1:${PORT}, sync completes in ${SYNC_SECONDS}s`);
});
