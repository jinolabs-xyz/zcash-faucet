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
// | SHIELD_ERROR |         | make z_shieldcoinbase THROW this message        |
// | RPC_USER     | unset   | With RPC_PASSWORD: require HTTP Basic auth, 401 otherwise |
// | RPC_PASSWORD | unset   |   (the real wallet always does; an app that forgot the header passed here) |
// | AUTH_FAIL_METHODS | unset | Comma list: these methods answer 401 even to the right credential |
// | WALLET_LAG   | 0       | Blocks the wallet stays behind the node, for the lag gate |
// | STALL_METHOD | unset   | With STALL_MS: this method never answers within STALL_MS |
// | STALL_MS     | 0       |   (the transport-timeout path: a reply lost, not an op that hangs) |
// | BRANCH_ID    | unset   | consensus.chaintip in getblockchaininfo; unset omits it, so the chain-identity oracle stays cannot-verify instead of comparing a fixture id against the live network's |
//
// WHAT IT ANSWERS THAT THE REAL WALLET WOULD NOT (risk register II, R-41). A double
// bounds what a test can prove, so it should say no where zallet says no: without
// credentials (401), to an opid it never issued (an empty list, not "success"), and to
// a send whose privacy policy does not cover its recipient (-8, in zallet's own
// sentences from zallet_core.ftl, so the app's recipient-refusal classifier sees what it
// sees in production). Each is a knob or a rule here, and the integration suite has one
// assertion per rule.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 28299);
const SYNC_SECONDS = Number(process.env.SYNC_SECONDS ?? 0);
const ZAT_PER_TAZ = 100_000_000n;
const SHIELD_ZAT = BigInt(Math.round(Number(process.env.SHIELD_TAZ ?? 0) * 1e8));
// Message the shield RPC should throw instead of sweeping. Empty means do not throw.
const SHIELD_ERROR = process.env.SHIELD_ERROR ?? "";
const SEND_FAILS = process.env.SEND_FAILS === "true";
const SEND_HANGS = process.env.SEND_HANGS === "true";
const RPC_USER = process.env.RPC_USER ?? "";
const RPC_PASSWORD = process.env.RPC_PASSWORD ?? "";
if (RPC_PASSWORD && !RPC_USER) {
  // A password with no user would silently return the double to "accepts anyone", the
  // state R-41 exists to end. Refuse to start rather than start lenient.
  console.error("fake-zallet: RPC_PASSWORD is set but RPC_USER is not; set both or neither");
  process.exit(2);
}
const AUTH_FAIL_METHODS = new Set((process.env.AUTH_FAIL_METHODS ?? "").split(",").map((m) => m.trim()).filter(Boolean));
const WALLET_LAG = Number(process.env.WALLET_LAG ?? 0);
const STALL_METHOD = process.env.STALL_METHOD ?? "";
const STALL_MS = Number(process.env.STALL_MS ?? 0);
const BRANCH_ID = process.env.BRANCH_ID ?? "";
const NODE_TIP = 3_650_000;
const started = Date.now();

// Real state, not a constant: it decrements on send and grows on a shield
// sweep, which is what makes the low-balance guard, the empty state and the
// reserve loop exercisable with no chain.
let balanceZat = BigInt(Math.round(Number(process.env.BALANCE_TAZ ?? 15) * 1e8));
const ops = new Map(); // opid -> { txid, failed }

function walletTip() {
  if (SYNC_SECONDS <= 0) return NODE_TIP - WALLET_LAG;
  const frac = Math.min(1, (Date.now() - started) / (SYNC_SECONDS * 1000));
  return NODE_TIP - Math.round(5000 * (1 - frac)) - WALLET_LAG;
}

// zallet's privacy lattice, the two rules a drip can trip. A transparent recipient needs
// AllowRevealedRecipients or a policy above it; AllowRevealedAmounts is NOT above it
// (meet(AllowRevealedAmounts, AllowRevealedRecipients) is AllowRevealedRecipients), which
// matters because that is exactly the policy the app sends for Sapling, one line away
// from the transparent case in zalletsend.ts. A Sapling recipient paid from an Orchard
// pool reveals the moved amount, so FullPrivacy refuses it: the 2026-09-10 shape, two
// claims dead after their proof-of-work. Both refusals are -8 with zallet's sentence.
const REVEALS_RECIPIENTS = new Set(["AllowRevealedRecipients", "AllowFullyTransparent", "NoPrivacy"]);
const REVEALS_AMOUNTS = new Set(["AllowRevealedAmounts", ...REVEALS_RECIPIENTS]);
const ERR_TRANSPARENT_RECIPIENT = "This transaction would have transparent recipients, which is not enabled by default because it will publicly reveal transaction recipients and amounts.";
const ERR_REVEALING_AMOUNT = "Could not send to the Sapling shielded pool without spending non-Sapling funds, which would reveal transaction amounts.";

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
    const to = String(params[1]?.[0]?.address ?? "");
    const policy = params[4] ?? "FullPrivacy";
    if (/^t[m2]/.test(to) && !REVEALS_RECIPIENTS.has(policy)) {
      throw Object.assign(new Error(ERR_TRANSPARENT_RECIPIENT), { code: -8 });
    }
    if (/^ztestsapling/.test(to) && !REVEALS_AMOUNTS.has(policy)) {
      throw Object.assign(new Error(ERR_REVEALING_AMOUNT), { code: -8 });
    }
    if (!SEND_FAILS && amountZat > balanceZat) throw new Error("Insufficient funds");
    const opid = "opid-" + randomBytes(4).toString("hex");
    if (!SEND_FAILS) balanceZat -= amountZat; // debit at submit, as a real wallet reserves the note
    ops.set(opid, { txid: randomBytes(32).toString("hex"), failed: SEND_FAILS });
    return opid;
  },

  z_shieldcoinbase: () => {
    // The double could express "swept nothing" but not "the sweep THREW", which is the
    // state the live loop sat in for a day while every counter read clean. Without
    // this the failure path is unreachable in a test.
    if (SHIELD_ERROR) {
      const err = new Error(SHIELD_ERROR);
      err.code = -4;
      throw err;
    }
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

  // An opid this wallet never issued is an EMPTY list, as zcashd and zallet answer it.
  // The double used to say "success", so a client that lost track of which opid was
  // whose would have been told its money went out.
  z_getoperationstatus: (params) => {
    const id = params[0][0];
    if (!ops.has(id)) return [];
    if (SEND_HANGS) return [{ id, status: "executing" }];
    return [{ id, status: ops.get(id).failed ? "failed" : "success" }];
  },

  z_getoperationresult: (params) => {
    const id = params[0][0];
    const op = ops.get(id);
    if (!op) return [];
    if (op.failed) return [{ id, status: "failed", error: { code: -6, message: "fake-zallet: send refused" } }];
    return [{ id, status: "success", result: { txid: op.txid } }];
  },

  // The chain-identity oracle's first question. Zebra's shape (consensus.chaintip); the
  // real wallet proxies it. The branch id is only there when BRANCH_ID says so: the other
  // side of that comparison is the LIVE lightwalletd (the suite pins only the tip
  // oracle), and a fixture id would read "different-rules" against the real network on
  // every run with egress and "cannot-verify" without it (review of #544). Unset, the
  // oracle stays cannot-verify, which is what it read before this handler existed.
  getblockchaininfo: () => ({
    chain: "test",
    blocks: NODE_TIP,
    headers: NODE_TIP,
    ...(BRANCH_ID ? { consensus: { chaintip: BRANCH_ID, nextblock: BRANCH_ID } } : {}),
  }),
};

function authorized(req, method) {
  if (AUTH_FAIL_METHODS.has(method)) return false;
  if (!RPC_USER) return true;
  const want = "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString("base64");
  return req.headers.authorization === want;
}
function unauthorized(res) {
  // The real wallet: 401 and no JSON-RPC envelope. The app must read that as a
  // definite failure, never as an ambiguous send.
  res.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Basic realm=\"jsonrpc\"" });
  res.end("Unauthorized");
}

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let out;
    try {
      const { method, params } = JSON.parse(body);
      if (!authorized(req, method)) { unauthorized(res); return; }
      if (STALL_METHOD && method === STALL_METHOD && STALL_MS > 0) {
        // Never answers inside the caller's timeout: the reply-lost path, which is not
        // the same as an operation that hangs (SEND_HANGS answers "executing" at once).
        setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", result: null })); }, STALL_MS);
        return;
      }
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
      // A body that is not JSON-RPC still needs the credential before it is told so.
      if (!authorized(req, "")) { unauthorized(res); return; }
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
