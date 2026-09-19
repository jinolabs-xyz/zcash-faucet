import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordNodeStatusLatency,
  recordCensoredRead,
  recordRecoveredOnRetry,
  nodeStatusLatency,
  reportNodeStatusShape,
  LATENCY_BUCKET_EDGES_MS,
  classifyNodeStatusError,
  recordNodeStatusFailure,
  nodeStatusFailureCounts,
  resetNodeStatusFailures,
  NODE_STATUS_FAILURE_KINDS,
} from "./nodeStatusFailure.ts";

const lines: string[] = [];
const write = (l: string) => { lines.push(l); };
function fresh() { resetNodeStatusFailures(); lines.length = 0; }

test("a timeout and a refused connection are different classes, because they send you to different places", () => {
  // AbortSignal.timeout rejects with TimeoutError; other runtimes abort with AbortError. Both are
  // "the wallet is reachable and did not answer", which is not "nothing is listening".
  assert.equal(classifyNodeStatusError(Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
  assert.equal(classifyNodeStatusError(Object.assign(new Error("x"), { name: "AbortError" })), "timeout");
  assert.equal(classifyNodeStatusError(Object.assign(new Error("x"), { name: "SyntaxError" })), "parse");
  assert.equal(classifyNodeStatusError(Object.assign(new Error("x"), { name: "TypeError" })), "network");
  // Anything at all, including a thrown non-Error, still lands somewhere rather than throwing.
  assert.equal(classifyNodeStatusError("just a string"), "network");
  assert.equal(classifyNodeStatusError(null), "network");
});

test("the first of each class is written immediately, because the first one is the news", () => {
  fresh();
  for (const k of NODE_STATUS_FAILURE_KINDS) {
    const line = recordNodeStatusFailure(k, null, 1_000, write);
    assert.ok(line, `${k} was swallowed`);
    assert.match(line, new RegExp(`read failed: ${k}`));
  }
  assert.equal(lines.length, NODE_STATUS_FAILURE_KINDS.length);
});

test("and the flapping that follows is throttled, or it trains a reader to skip the line", () => {
  fresh();
  recordNodeStatusFailure("timeout", null, 0, write);      // the first: written
  assert.equal(lines.length, 1);
  for (let i = 1; i <= 50; i++) recordNodeStatusFailure("timeout", null, i * 1_000, write);
  // 50 more failures across 50 seconds, inside one throttle window.
  assert.equal(lines.length, 1, `wrote ${lines.length} lines for 51 failures in under a minute`);
  assert.equal(nodeStatusFailureCounts().timeout, 51, "the COUNT must keep rising while the log is quiet");
});

test("when it does speak again it says how many it swallowed, which is the number a rate comes from", () => {
  fresh();
  recordNodeStatusFailure("timeout", null, 0, write);
  for (let i = 1; i <= 9; i++) recordNodeStatusFailure("timeout", null, i * 1_000, write);
  const line = recordNodeStatusFailure("timeout", null, 61_000, write);
  assert.ok(line, "the throttle never reopened");
  // 9 swallowed plus the one that reopened it.
  assert.match(line, /10 since the last line/);
  assert.match(line, /11 since start/);
});

test("the throttle is per class, so a noisy timeout cannot silence a recurring http failure", () => {
  fresh();
  // BOTH CLASSES MUST BE PAST THEIR FIRST, or this proves nothing: the first of any class is
  // written whatever the throttle says, so a test that leans on it passes under a GLOBAL throttle
  // too. Measured - the earlier version of this row did exactly that and a global-throttle mutant
  // survived it.
  recordNodeStatusFailure("http", "status 500", 0, write);
  recordNodeStatusFailure("timeout", null, 0, write);
  lines.length = 0;
  // A minute of timeouts, which reopens the TIMEOUT window and would reopen a shared one.
  for (let i = 1; i <= 70; i++) recordNodeStatusFailure("timeout", null, i * 1_000, write);
  const http = recordNodeStatusFailure("http", "status 500", 70_500, write);
  assert.ok(http, "a recurring http failure was silenced by an unrelated class's throttle");
  assert.match(http, /status 500/);
});

test("nothing it writes can carry a credential, because this call is the one that has them", () => {
  fresh();
  // The endpoint and its auth header are in scope at every call site. The recorder takes only a
  // short detail, and these are the only details the app passes.
  const written = [
    recordNodeStatusFailure("http", "status 401", 0, write),
    recordNodeStatusFailure("parse", "wallet_tip missing, node_tip present", 0, write),
    recordNodeStatusFailure("network", null, 0, write),
  ].filter(Boolean) as string[];
  for (const l of written) {
    assert.doesNotMatch(l, /http:\/\/|https:\/\/|Basic |Bearer |password|:\/\//i, `a line carried more than a class: ${l}`);
  }
});

test("the counters are a copy, so a caller holding them cannot rewrite the record", () => {
  fresh();
  recordNodeStatusFailure("parse", null, 0, write);
  const got = nodeStatusFailureCounts();
  got.parse = 999;
  assert.equal(nodeStatusFailureCounts().parse, 1);
});


/* ── the latency half ───────────────────────────────────────────────────────────────────────── */

test("an aborted read is NEVER a latency bucket, because we stopped waiting - we did not measure", () => {
  // THE POINT OF THE WHOLE DESIGN (@SDE-Research). This counter lives inside the app and the app
  // hangs up at its own deadline, so a bucket can only ever hold reads that CAME BACK. An aborted
  // call filed under "8-12s" would read like a measurement and be a limit of our patience - and
  // an empty top bucket would read like good news while meaning "we never looked".
  fresh();
  for (let i = 0; i < 5; i++) recordCensoredRead();
  const v = nodeStatusLatency();
  assert.equal(v.censoredAtOurDeadline, 5);
  assert.equal(Object.values(v.buckets).reduce((a, b) => a + b, 0), 0, "a censored read reached a bucket");
  assert.equal(v.slowestObservedMs, 0, "a read we abandoned must not become the slowest OBSERVED one");
});

test("the boundaries sit ON the deadlines, so a bucket can answer did-this-cross-the-line", () => {
  // A bucket STRADDLING a timeout cannot answer the only question asked of it. 4s was the old
  // budget and 12s is the new one; both must be edges, not interiors.
  for (const deadline of [4_000, 12_000]) {
    assert.ok((LATENCY_BUCKET_EDGES_MS as readonly number[]).includes(deadline), `${deadline} must be a bucket edge`);
  }
  // And the healthy mode is 2-21ms, so the bottom must resolve below 100ms or the entire normal
  // distribution lands in one bucket and a 10x drift is invisible.
  assert.ok(LATENCY_BUCKET_EDGES_MS[0] <= 100, `got ${LATENCY_BUCKET_EDGES_MS[0]}`);
});

test("a read lands in the bucket below its edge, and the edge itself lands above", () => {
  fresh();
  recordNodeStatusLatency(49);
  recordNodeStatusLatency(50);
  recordNodeStatusLatency(3_999);
  recordNodeStatusLatency(4_000);
  const b = nodeStatusLatency().buckets;
  assert.equal(b["<50ms"], 1);
  assert.equal(b["50-250ms"], 1);
  assert.equal(b["2-4s"], 1, "3999ms must be under the 4s edge");
  assert.equal(b["4-8s"], 1, "4000ms must be at or over it");
});

test("the single worst reading survives, because a histogram loses the one that explains an outage", () => {
  fresh();
  recordNodeStatusLatency(120);
  recordNodeStatusLatency(6_508);
  recordNodeStatusLatency(300);
  assert.equal(nodeStatusLatency().slowestObservedMs, 6_508);
});

test("a retry that saved the call is counted apart from one that did not", () => {
  // #688 retries on a shared budget, so a first attempt failing and a second saving it is a
  // WOBBLE and both failing is a STATE. From outside they are indistinguishable - one successful
  // read either way - so the app is the only place the difference exists.
  fresh();
  recordRecoveredOnRetry();
  recordRecoveredOnRetry();
  assert.equal(nodeStatusLatency().recoveredOnRetry, 2);
  assert.equal(nodeStatusLatency().censoredAtOurDeadline, 0, "a recovery is not a censored read");
});

test("nonsense durations are dropped rather than skewing the shape", () => {
  fresh();
  for (const bad of [NaN, Infinity, -1]) recordNodeStatusLatency(bad as number);
  assert.equal(Object.values(nodeStatusLatency().buckets).reduce((a, b) => a + b, 0), 0);
  assert.equal(nodeStatusLatency().slowestObservedMs, 0);
});


test("the shape line leads with recovered-on-retry, because it is the headline not a footnote", () => {
  // #688 raised the budget AND added a retry in one change, so "the nulls went away" afterwards has
  // two meanings that are identical from outside: the calls got fast enough, or a second attempt is
  // rescuing a first that still fails. This counter is the only thing that separates them
  // (@SDE-Research), so it must be readable without an ops token.
  fresh();
  recordNodeStatusLatency(120);
  recordRecoveredOnRetry();
  recordCensoredRead();
  const line = reportNodeStatusShape(0, write);
  assert.ok(line, "nothing was reported at all");
  assert.match(line, /recovered-on-retry=1/);
  // Censored is NAMED as censored rather than folded into a bucket.
  assert.match(line, /censored=1/);
  assert.match(line, /slowest-returned=120ms/);
  assert.ok(line.indexOf("recovered-on-retry") < line.indexOf("censored"), "the headline must come first");
});

test("it says nothing when nothing has happened, or it is the noise that trains a reader to skip", () => {
  fresh();
  assert.equal(reportNodeStatusShape(0, write), null, "reported a shape with no reads at all");
  assert.equal(lines.length, 0);
});

test("and it is throttled, so a busy process does not write a line per read", () => {
  fresh();
  recordNodeStatusLatency(10);
  assert.ok(reportNodeStatusShape(0, write), "the first report was swallowed");
  for (let i = 1; i <= 50; i++) {
    recordNodeStatusLatency(10);
    assert.equal(reportNodeStatusShape(i * 1_000, write), null, `wrote a second line at ${i}s`);
  }
  assert.ok(reportNodeStatusShape(61_000, write), "the throttle never reopened");
});

test("an empty top bucket is never presented as a measurement", () => {
  // The buckets it prints are the ones with reads in them. A ">=12s=0" beside a censored count
  // would read as "nothing was that slow" when it means "we hung up first".
  fresh();
  recordNodeStatusLatency(30);
  for (let i = 0; i < 4; i++) recordCensoredRead();
  const line = reportNodeStatusShape(0, write);
  assert.ok(line);
  assert.doesNotMatch(line, />=12s=0/);
  assert.match(line, /censored=4/);
});
