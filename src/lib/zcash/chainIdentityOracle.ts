/**
 * Runs the #249 comparison against live sources. chainIdentity.ts decides what a set
 * of facts MEANS; this gathers the facts and caches the verdict.
 *
 * Non-blocking, for the same reason externalTip is: /api/status must never wait on a
 * public endpoint. Callers get the last-known verdict immediately and a stale cache
 * triggers a background refresh.
 *
 * SCOPE, and this is the honest part. Only the RULES half is wired. Comparing history
 * needs a block hash at a chosen height from both sides, and neither side can supply
 * one today: our app speaks two RPC methods to zallet and neither returns a hash, and
 * the lightwalletd client has no GetBlock-by-height helper. So `comparedAtHeight` and
 * both hashes are passed as null on purpose, and classifyChainIdentity answers
 * cannot-verify for history while still reporting a rules mismatch as different-rules.
 *
 * That is a detector that runs and is honest about its reach, rather than one that
 * looks complete and silently answers only one of the two questions.
 */
import { config } from "../config.ts";
import { getLightdInfo } from "./grpc.ts";
import {
  classifyChainIdentity,
  type IdentityVerdict,
} from "./chainIdentity.ts";

const STALE_MS = 60_000;
/** Past this we stop claiming to know, rather than serving an ancient verdict. */
const MAX_AGE_MS = 10 * 60_000;

const UNKNOWN: IdentityVerdict = {
  state: "cannot-verify",
  reason: "chain identity has not been read yet",
};

let cache: { verdict: IdentityVerdict; at: number } = { verdict: UNKNOWN, at: 0 };
let refreshing = false;

/**
 * Our node's consensus branch id.
 *
 * Deliberately tolerant of shape: zebra reports `consensus.chaintip`, zcashd-derived
 * wallets report `consensusBranchId`, and we have not verified which zallet exposes.
 * An unsupported method returns null, which becomes cannot-verify rather than a
 * mismatch. Absence of an answer is not evidence of a different chain (#224).
 */
export interface BranchIdRpc {
  result?: { consensus?: { chaintip?: string }; consensusBranchId?: string };
}

/**
 * Pull the branch id out of a getblockchaininfo response.
 *
 * Exported because this is the only part with a decision in it, and it is the part
 * most likely to be wrong: we have not verified which shape zallet returns, so it
 * accepts both and returns null rather than guessing. Null is cannot-verify, never
 * a mismatch.
 */
export function branchIdFromRpc(json: BranchIdRpc): string | null {
  return json.result?.consensus?.chaintip ?? json.result?.consensusBranchId ?? null;
}

/**
 * WHY our side was silent, when it was. Null alone cannot say whether the method is absent, the
 * auth is wrong, or the node is unreachable - three different owners behind one value - and on
 * 2026-09-16 that ambiguity cost an investigation into a fact #533 had already recorded.
 *
 * Module-scoped rather than returned, because the verdict type is facts-only on purpose:
 * chainIdentity.ts decides what facts MEAN and must stay testable without a node.
 */
let lastOurFailure: string | null = null;

async function ourBranchId(): Promise<string | null> {
  const { endpoint, user, password } = config.zallet;
  if (!endpoint) return null;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (user) headers.authorization = `Basic ${Buffer.from(`${user}:${password ?? ""}`).toString("base64")}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: `{"jsonrpc":"2.0","id":"chainid","method":"getblockchaininfo","params":[]}`,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      lastOurFailure = `zallet answered HTTP ${res.status}`;
      return null;
    }
    const json = (await res.json()) as BranchIdRpc & { error?: { code?: number; message?: string } };
    // A JSON-RPC ERROR ARRIVES AT HTTP 200, so `res.ok` is true and the old code fell straight
    // through to the parse, where a missing `result` returned null exactly as a missing FIELD
    // would. Measured on prod 2026-09-16: zallet answers 200 with
    // {"error":{"code":-32601,"message":"Method not found"}} - it does not implement
    // getblockchaininfo at all (#533 cites the source tree). "The method does not exist" and
    // "the node did not fill in the field" are different problems with different owners, and
    // they were the same null.
    if (json.error) {
      lastOurFailure = `zallet: ${json.error.message ?? "RPC error"}${json.error.code != null ? ` (${json.error.code})` : ""}`;
      return null;
    }
    const id = branchIdFromRpc(json);
    lastOurFailure = id === null ? "zallet answered without a consensus branch id" : null;
    return id;
  } catch (e) {
    lastOurFailure = `zallet unreachable: ${e instanceof Error ? e.message : "unknown"}`;
    return null;
  }
}

async function theirBranchId(): Promise<string | null> {
  try {
    const { info } = await getLightdInfo();
    return info.consensusBranchId ?? null;
  } catch {
    return null;
  }
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    // Both sides in parallel: neither depends on the other, and serialising them
    // would double the window in which the verdict is stale.
    const [ours, theirs] = await Promise.all([ourBranchId(), theirBranchId()]);
    cache = {
      verdict: classifyChainIdentity({
        ourBranchId: ours,
        theirBranchId: theirs,
        ourBranchIdDetail: lastOurFailure,
        // History is not wired: see the module header. Null here produces
        // cannot-verify for the history half, never a false same-chain.
        comparedAtHeight: null,
        ourHashAtHeight: null,
        theirHashAtHeight: null,
      }),
      at: Date.now(),
    };
  } finally {
    refreshing = false;
  }
}

/** Kick a first read at boot so the first /api/status has a verdict. */
export function warmChainIdentity(): Promise<void> {
  return refresh();
}

/**
 * The last-known chain-identity verdict. Never blocks and never throws.
 *
 * A verdict older than MAX_AGE_MS becomes cannot-verify rather than being served as
 * though it were current: a stale "same-chain" is exactly the reassurance this check
 * exists to stop us giving ourselves.
 */
export function getChainIdentity(): IdentityVerdict {
  const age = Date.now() - cache.at;
  if (cache.at === 0 || age > STALE_MS) void refresh();
  if (cache.at === 0) return UNKNOWN;
  if (age > MAX_AGE_MS) {
    return {
      state: "cannot-verify",
      reason: `the last chain-identity reading is ${Math.round(age / 60_000)} minutes old, so it no longer describes now`,
    };
  }
  return cache.verdict;
}
