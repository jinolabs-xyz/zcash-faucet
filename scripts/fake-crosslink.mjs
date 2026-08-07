// A fake Crosslink zebrad JSON-RPC node. TEST INFRASTRUCTURE, never shipped: the app
// runs its real CrosslinkSender against this, so the path under test is the production
// one and only the network boundary is faked.
//
//   node scripts/fake-crosslink.mjs
//   FAUCET_BUSY=1 node scripts/fake-crosslink.mjs      # the 16-deep queue is full
//   TFL_ACTIVATED=false node scripts/fake-crosslink.mjs # TFL not activated yet
//
// EVERY SHAPE HERE IS OBSERVED, not guessed, from the spike on branch
// spike/crosslink-headless (docs/spikes/crosslink-headless.md). Where the spike did not
// observe something, this says so rather than inventing a plausible value, because a
// double that invents is a double that can certify our code against a contract the real
// node does not have.
//
// | Variable       | Default | Effect                                              |
// |----------------|---------|-----------------------------------------------------|
// | PORT           | 28399   | RPC port                                            |
// | FAUCET_BUSY    | unset   | queue full, so every donation is refused            |
// | FAUCET_ERROR   | unset   | the method returns this JSON-RPC error message      |
// | TFL_ACTIVATED  | true    | is_tfl_activated, and whether recency reports data  |
// | RECENCY_HEIGHT | 372000  | my_height in get_tfl_recency_status                 |
// | RECENCY_LAG    | 0       | seconds to subtract from now_utc, for a stale tip   |
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 28399);
// Sync position. Equal by default, because the double's job is to let a claim succeed;
// set CTAZ_BLOCKS below CTAZ_TIP to model a node that is behind.
const CTAZ_TIP = Number(process.env.CTAZ_TIP ?? 293_300);
const CTAZ_BLOCKS = Number(process.env.CTAZ_BLOCKS ?? CTAZ_TIP);
const TFL_ACTIVATED = process.env.TFL_ACTIVATED !== "false";
const RECENCY_HEIGHT = Number(process.env.RECENCY_HEIGHT ?? 372000);
const RECENCY_LAG = Number(process.env.RECENCY_LAG ?? 0);

/** Their constant, from wallet/src/lib.rs. Fixed, and it ignores what the caller asks. */
const FAUCET_VALUE = 50_000_000;

// Addresses whose previous request has not drained yet. Their entire abuse story is this
// set plus a 16-deep queue, which is exactly why we are fronting the primitive rather
// than exposing it: everything else, cooldowns, caps, IP limits, is ours to add.
const pending = new Set();

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });

/**
 * THE PARAMETER SHAPE IS THE POINT OF THIS DOUBLE.
 *
 * `requestfaucetdonation` takes a FaucetRequest struct, so params are
 * `[{"address": "..."}]`. A bare string array is rejected with `Invalid params`, which
 * cost the spike two calls and was nearly written up as their validator rejecting a good
 * address.
 *
 * A double that accepted `["addr"]` would let us ship the wrong shape and pass every
 * test we have. It has to be able to fail us, or it is certifying our code against a
 * contract the real node does not offer.
 */
function faucetDonation(id, params) {
  const first = Array.isArray(params) ? params[0] : undefined;
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    return rpcError(id, -32602, "Invalid params");
  }
  const address = first.address;
  if (typeof address !== "string" || address.length < 8) {
    return rpcError(id, -32602, "Invalid params");
  }
  if (process.env.FAUCET_ERROR) return rpcError(id, -32000, process.env.FAUCET_ERROR);
  // Their message, verbatim, because our backend should be readable against their words.
  if (process.env.FAUCET_BUSY) return rpcError(id, -32000, "faucet too busy, come back later");
  if (pending.has(address)) return rpcError(id, -32000, "faucet too busy, come back later");

  // NO TXID. Their response is the amount and nothing else, so a caller cannot report a
  // transaction id, link an explorer, or prove the send from this reply alone. Modelled
  // exactly, because the tempting fix downstream is to manufacture one.
  pending.add(address);
  setTimeout(() => pending.delete(address), 50);
  return rpcOk(id, { amount: FAUCET_VALUE });
}

/**
 * The readiness primitive, and a better one than the TAZ side has: it reports the
 * finalizer view rather than only a tip height. Fields are those observed on a node
 * joined to the live feature net.
 */
function recencyStatus(id) {
  if (!TFL_ACTIVATED) return rpcError(id, -32000, "TFL is not activated");
  return rpcOk(id, {
    now_utc: Math.floor(Date.now() / 1000) - RECENCY_LAG,
    my_height: RECENCY_HEIGHT,
    my_round: 41,
    my_locked_round: 40,
    finalizer_statuses: [
      { pub_key: "aa".repeat(16), voting_power: 1, votes: 41 },
      { pub_key: "bb".repeat(16), voting_power: 1, votes: 41 },
    ],
  });
}

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(rpcError(null, -32700, "Parse error")));
    }
    const { id = null, method, params } = msg ?? {};
    let out;
    switch (method) {
      case "requestfaucetdonation": out = faucetDonation(id, params); break;
      case "get_tfl_recency_status": out = recencyStatus(id); break;
      case "is_tfl_activated": out = rpcOk(id, TFL_ACTIVATED); break;
      // getinfo, which real zebrad answers and this double did not. Its absence is why a
      // change that made the sync gate require a tip passed every local check and failed
      // CI: the RPC path had no way to learn either figure, so it could never serve.
      // CTAZ_BLOCKS below its tip models a node still catching up.
      //
      // NO estimatedheight HERE ANY MORE, because the real build has none. Measured on
      // the live node: getinfo returns exactly twelve fields - blocks, build, connections,
      // difficulty, errors, errorstimestamp, paytxfee, protocolversion, relayfee,
      // subversion, testnet, version - and not one of them is a tip. This double answered
      // with a tip anyway, so it modelled a node that cannot exist, and the reader was
      // written against the fiction. ctaz-status.sh hit the same wall on the box and its
      // header records it: the panel read "sync unknown" on a node sitting at the tip.
      case "getinfo": out = rpcOk(id, { blocks: CTAZ_BLOCKS, subversion: "/CrosslinkDouble/" }); break;
      // WHERE THE TIP ACTUALLY LIVES. Added when the reader moved to it (#409); without
      // this the double answers "method not found", blocks and tip come back null, and
      // canServeCtaz correctly refuses - which is how a faithful gate plus an unfaithful
      // double produced a red CI on a change that was right.
      case "getblockchaininfo":
        out = rpcOk(id, { blocks: CTAZ_BLOCKS, headers: CTAZ_TIP, estimatedheight: CTAZ_TIP });
        break;
      // Deliberately absent: there is no balance method in the observed surface. The
      // spike found get_wallet_ufvk and the TFL family, and nothing that reports what
      // the mining wallet holds. Answering one here would let us build a balance the
      // real node cannot give us.
      default: out = rpcError(id, -32601, `Method not found: ${method}`);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`fake-crosslink on 127.0.0.1:${PORT} (tfl ${TFL_ACTIVATED ? "active" : "inactive"})`);
});
