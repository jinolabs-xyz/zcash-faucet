// A fake Zallet JSON-RPC wallet. TEST INFRASTRUCTURE, never shipped: the app
// runs its real ZalletSender against this, so the path under test is the
// production one and only the network boundary is faked.
//
//   node scripts/fake-zallet.mjs
//   BALANCE_TAZ=0 PORT=28300 node scripts/fake-zallet.mjs   # an empty wallet
//   SYNC_SECONDS=45 node scripts/fake-zallet.mjs            # slow first sync
//
// Point the app at it:
//   FAUCET_SENDER=zallet ZALLET_RPC_URL=http://127.0.0.1:28299/ \
//   ZALLET_ACCOUNT=fake-account ZALLET_ADDRESS=utest1fake PORT=3100 npm start
//
// | Variable     | Default | Effect                                          |
// |--------------|---------|-------------------------------------------------|
// | PORT         | 28299   | RPC port                                        |
// | BALANCE_TAZ  | 15      | Starting spendable balance. 0 boots empty.      |
// | SYNC_SECONDS | 0       | Seconds to reach tip. 0 is synced immediately.  |
// | SEND_FAILS   | unset   | Every send fails, for the failure path          |
// | SEND_HANGS   | unset   | Operations never finish, for unknown outcome    |
// | SHIELD_TAZ   | 0       | TAZ each shield sweep adds, for refill tests    |
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 28299);
const SYNC_SECONDS = Number(process.env.SYNC_SECONDS ?? 0);
const ZAT_PER_TAZ = 100_000_000n;
const SHIELD_ZAT = BigInt(Math.round(Number(process.env.SHIELD_TAZ ?? 0) * 1e8));
const SEND_FAILS = process.env.SEND_FAILS === "true";
const SEND_HANGS = process.env.SEND_HANGS === "true";
const NODE_TIP = 3_650_000;
const started = Date.now();

// Real state, not a constant: it decrements on send and grows on a shield
// sweep, which is what makes the low-balance guard, the empty state and the
// reserve loop exercisable with no chain.
let balanceZat = BigInt(Math.round(Number(process.env.BALANCE_TAZ ?? 15) * 1e8));
const ops = new Map(); // opid -> { txid, failed }

function walletTip() {
  if (SYNC_SECONDS <= 0) return NODE_TIP;
  const frac = Math.min(1, (Date.now() - started) / (SYNC_SECONDS * 1000));
  return NODE_TIP - Math.round(5000 * (1 - frac));
}

// Amounts arrive as exact ZEC decimal literals, so parse rather than float.
function zecToZat(amount) {
  const [whole, frac = ""] = String(amount).split(".");
  return BigInt(whole) * ZAT_PER_TAZ + BigInt((frac + "00000000").slice(0, 8));
}

const handlers = {
  getwalletstatus: () => ({ wallet_tip: { height: walletTip() }, node_tip: { height: NODE_TIP } }),
  z_getbalanceforaccount: () => ({ pools: { orchard: { valueZat: balanceZat.toString() } } }),
  walletpassphrase: () => null,

  z_sendmany: (params) => {
    const amountZat = zecToZat(params[1]?.[0]?.amount ?? 0);
    if (!SEND_FAILS && amountZat > balanceZat) throw new Error("Insufficient funds");
    const opid = "opid-" + randomBytes(4).toString("hex");
    if (!SEND_FAILS) balanceZat -= amountZat; // debit at submit, as a real wallet reserves the note
    ops.set(opid, { txid: randomBytes(32).toString("hex"), failed: SEND_FAILS });
    return opid;
  },

  z_shieldcoinbase: () => {
    if (SHIELD_ZAT <= 0n) return { remainingUTXOs: 0 };
    const opid = "opid-shield-" + randomBytes(4).toString("hex");
    balanceZat += SHIELD_ZAT;
    ops.set(opid, { txid: randomBytes(32).toString("hex"), failed: false });
    return { opid, shieldingUTXOs: 1 };
  },

  // Node truth for /api/tx: known if we minted it, -5 if not, which is what
  // zallet returns (LegacyCode::InvalidAddressOrKey).
  getrawtransaction: (params) => {
    const txid = params[0];
    const known = [...ops.values()].some((o) => o.txid === txid && !o.failed);
    if (!known) throw Object.assign(new Error("No such mempool or blockchain transaction"), { code: -5 });
    return { txid, confirmations: Number(process.env.TX_CONFIRMATIONS ?? 1), height: NODE_TIP };
  },

  z_getoperationstatus: (params) => {
    const id = params[0][0];
    if (SEND_HANGS) return [{ id, status: "executing" }];
    return [{ id, status: ops.get(id)?.failed ? "failed" : "success" }];
  },

  z_getoperationresult: (params) => {
    const id = params[0][0];
    const op = ops.get(id);
    if (!op || op.failed) {
      return [{ id, status: "failed", error: { code: -6, message: "fake-zallet: send refused" } }];
    }
    return [{ id, status: "success", result: { txid: op.txid } }];
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
      if (!handler) {
        out = { jsonrpc: "2.0", error: { code: -32601, message: `fake-zallet: no handler for ${method}` } };
      } else {
        try {
          out = { jsonrpc: "2.0", result: handler(params ?? []) };
        } catch (err) {
          out = { jsonrpc: "2.0", error: { code: err.code ?? -6, message: err.message } };
        }
      }
    } catch {
      out = { jsonrpc: "2.0", error: { code: -32700, message: "parse error" } };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(
    `fake-zallet on 127.0.0.1:${PORT}, balance ${(Number(balanceZat) / 1e8).toFixed(2)} TAZ, ` +
      `sync ${SYNC_SECONDS || "instant"}`,
  );
});
