import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordNodeStatusLatency,
  recordCensoredRead,
  recordRecoveredOnRetry,
  recordFailedAttempt,
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


test("the shape line states its WINDOW, or the counters are facts about nothing", () => {
  // L49: "recovered 12, censored 3" is a claim about an unnamed period and cannot be compared to
  // anything. These are cumulative since this process first saw a read, so the duration is the
  // only honest framing - and a restart resets them, which is exactly why it must be said.
  fresh();
  recordNodeStatusLatency(40, 0);
  const line = reportNodeStatusShape(660_000, write);
  assert.ok(line, "nothing reported");
  assert.match(line, /shape \(purpose=claim\) over 11m/, `window or purpose missing: ${line}`);
});

test("recovered and censored are printed TOGETHER even when one of them is zero", () => {
  // They are the success and failure halves of the same mitigation. recovered 50 / censored 0 is
  // "working"; recovered 50 / censored 40 is "papering". One alone cannot tell them apart, so
  // neither may be omitted for being zero.
  fresh();
  recordNodeStatusLatency(40, 0);
  for (let i = 0; i < 7; i++) recordRecoveredOnRetry();
  const line = reportNodeStatusShape(0, write);
  assert.ok(line);
  assert.match(line, /recovered-on-retry=7/);
  assert.match(line, /censored=0/, "censored was omitted for being zero");
});


test("a node that ONLY times out still reports a sane window, not the whole Unix epoch", () => {
  // The all-censored process is the one this feature exists for, and it is the one that records no
  // latency at all - so if only the latency path starts the clock, countingSince stays 0 and the
  // window is computed against the epoch. Found by a surviving mutant, not by reading the code.
  fresh();
  recordCensoredRead(1_600_000_000_000);
  recordCensoredRead(1_600_000_300_000);
  const line = reportNodeStatusShape(1_600_000_600_000, write);
  assert.ok(line, "nothing reported");
  assert.match(line, /shape \(purpose=claim\) over 10m:/, `window is not measured from the first censored read: ${line}`);
  assert.doesNotMatch(line, /over \d{5,}m/, `window computed against the epoch: ${line}`);
});


test("a fast FAILURE never enters a latency bucket, or the histogram reports the fastest node we ever ran", () => {
  // This is the whole point. A node refusing in 3ms and a node answering in 3ms are the same
  // number and opposite facts. SDE-Research reads mass in <50ms as evidence that a slow external
  // measurement was path rather than work - which is only true if everything in that bucket is an
  // ANSWER. One refused connection in there inverts the conclusion.
  fresh();
  recordFailedAttempt(3, 0);
  recordFailedAttempt(270, 1_000);
  const v = nodeStatusLatency();
  assert.equal(v.buckets["<50ms"], 0, "a 3ms refusal was counted as a 3ms read");
  assert.equal(Object.values(v.buckets).reduce((a, b) => a + b, 0), 0, "a failure reached a bucket");
  assert.equal(v.failedAttempts, 2);
  assert.equal(v.fastestFailureMs, 3, "the fastest failure is the signal App needs");
  assert.equal(v.slowestObservedMs, 0, "a failure moved slowest-RETURNED, which nothing returned");
});

test("the shape line reports failed attempts and how fast the fastest one died", () => {
  // A null at 4.27s on a 4s-then-8s ladder is one timeout plus one attempt that died in ~270ms.
  // Nothing outside the process can see the second half, so the line has to carry it.
  fresh();
  recordCensoredRead(0);
  recordFailedAttempt(270, 0);
  const line = reportNodeStatusShape(0, write);
  assert.ok(line);
  assert.match(line, /censored=1/);
  assert.match(line, /failed-attempts=1/);
  assert.match(line, /fastest-failure=270ms/);
});

test("failed-attempts is stated even when it is zero, so its absence is never read as 'not measured'", () => {
  fresh();
  recordNodeStatusLatency(40, 0);
  const line = reportNodeStatusShape(0, write);
  assert.ok(line);
  assert.match(line, /failed-attempts=0/, `a zero went unsaid: ${line}`);
});


test("with no successful reads, slowest-returned says none rather than 0ms", () => {
  // Seen on a real outage run: "failed-attempts=1 fastest-failure=2ms slowest-returned=0ms reads=0".
  // The 0ms is the good-news spelling of no data - a reader skimming for a slow node sees the
  // smallest possible number next to the word slowest.
  fresh();
  recordFailedAttempt(2, 0);
  const line = reportNodeStatusShape(0, write);
  assert.ok(line);
  assert.match(line, /slowest-returned=none/, `nothing returned, yet: ${line}`);
  assert.doesNotMatch(line, /slowest-returned=0ms/);
});


test("failures report BOTH ends, because one number turns a spread into a story", () => {
  // SDE-Research decomposed eight production nulls: the second component runs 0.31s to 2.27s, an
  // order of magnitude. Reporting only the fastest is true and leaves a reader certain the second
  // attempt dies instantly while a 2.27s case sits unreported in the same count. Same argument as
  // printing recovered beside censored.
  fresh();
  recordFailedAttempt(310, 0);
  recordFailedAttempt(2_270, 0);
  recordFailedAttempt(900, 0);
  const v = nodeStatusLatency();
  assert.equal(v.fastestFailureMs, 310);
  assert.equal(v.slowestFailureMs, 2_270);
  const line = reportNodeStatusShape(0, write);
  assert.ok(line);
  assert.match(line, /fastest-failure=310ms/);
  assert.match(line, /slowest-failure=2270ms/, `only one end was reported: ${line}`);
});


test("a page read and a claim read do not share counters, or the ratio is a fact about traffic mix", () => {
  // L57, one layer in. /api/status reads the node on the PAGE path (one 4s attempt, no retry) and
  // /api/ready on the CLAIM path ([4000, 8000]). Summed, one page read contributes at most one
  // censored and never a recovered, while one claim read can contribute two censored and a
  // recovered - so SDE-Research's censored-to-failed ratio could be moved by nothing but the mix of
  // page to ready traffic. Measured before the split: censored=1 after a page read, 3 after also a
  // claim read.
  fresh();
  recordCensoredRead(0, "page");
  recordCensoredRead(0, "claim");
  recordCensoredRead(0, "claim");
  recordRecoveredOnRetry("claim");
  assert.equal(nodeStatusLatency("page").censoredAtOurDeadline, 1, "a claim read reached the page counters");
  assert.equal(nodeStatusLatency("claim").censoredAtOurDeadline, 2, "a page read reached the claim counters");
  assert.equal(nodeStatusLatency("page").recoveredOnRetry, 0, "the page path cannot recover - it does not retry");
  assert.equal(nodeStatusLatency("claim").recoveredOnRetry, 1);
});

test("each path gets its own line, named, and its own throttle", () => {
  // Two callers with two different ladders write to one log. A reader who cannot tell which line
  // belongs to which path is in exactly the position that cost three sessions a day.
  fresh();
  recordCensoredRead(0, "page");
  recordCensoredRead(0, "claim");
  const pageLine = reportNodeStatusShape(0, write, "page");
  const claimLine = reportNodeStatusShape(0, write, "claim");
  assert.ok(pageLine && claimLine, "one of the paths stayed silent");
  assert.match(pageLine, /shape \(purpose=page\)/, pageLine);
  assert.match(claimLine, /shape \(purpose=claim\)/, claimLine);
  // The claim line must NOT have been swallowed by the page line's throttle - they are separate
  // instruments and one being recent says nothing about the other.
  assert.notEqual(pageLine, claimLine);
});


test("the LADDER leads the line, so nobody reads the claim counters as what a visitor experiences", () => {
  // SDE-Research: the claim counters are fed by /api/ready AND /api/faucet, and the watchdog polls
  // readiness every 30s while a claim needs a real person. So "claim" is mostly a robot, and the
  // word invites exactly the wrong reading. The ladder cannot be misread that way, and it is
  // computed from the attempts rather than asserted, so a new caller cannot make it stale.
  fresh();
  recordCensoredRead(0, "claim");
  const line = reportNodeStatusShape(0, write, "claim", [4000, 8000]);
  assert.ok(line);
  assert.match(line, /shape \(ladder 4000\+8000ms, purpose=claim\)/, line);
  fresh();
  recordCensoredRead(0, "page");
  const pageLine = reportNodeStatusShape(0, write, "page", [4000]);
  assert.ok(pageLine);
  assert.match(pageLine, /shape \(ladder 4000ms, purpose=page\)/, pageLine);
});


test("a failure on one path does not silence the same class on the other", () => {
  // Seen in a real two-path run: a `network` failure on the page ladder spoke, and the identical
  // failure on the claim ladder a moment later was swallowed by a throttle keyed on the class
  // alone. The line that DID speak names only its own path, so the reader concludes the page path
  // is failing while the claim path is equally broken and silent.
  fresh();
  const page = recordNodeStatusFailure("network", "after 4000ms on the page path", 0, write, "page");
  const claim = recordNodeStatusFailure("network", "after 12000ms on the claim path", 10, write, "claim");
  assert.ok(page, "the page failure said nothing at all");
  assert.ok(claim, "the claim failure was silenced by the page failure - different ladder, same class");
  assert.match(page, /page path/);
  assert.match(claim, /claim path/);
});


test("the two numbers on the repeat line count ONE population, not two", () => {
  // @SDE-App, #696 retro. `n` is per-path and the total was counts[kind], which is global across
  // both ladders, so the sentence paired a per-path figure with a two-path total. A reader takes
  // "3 since the last line, 9 since start" as one series; it was two.
  fresh();
  // five failures on the PAGE path, then one on the CLAIM path, all the same kind
  for (let i = 0; i < 5; i++) recordNodeStatusFailure("network", null, i, write, "page");
  const claimFirst = recordNodeStatusFailure("network", null, 0, write, "claim");
  assert.ok(claimFirst && /Readiness answers/.test(claimFirst), "the claim path's FIRST line should be the first-failure wording");
  // a second claim-path failure, past the throttle, so it prints the repeat line
  const line = recordNodeStatusFailure("network", null, 120_000, write, "claim");
  assert.ok(line, "the repeat line was throttled away, so this row measured nothing");
  assert.match(line, /since start on this path/, line);
  // TWO on the claim path, not seven. Seven would be the two ladders added together.
  assert.match(line, /2 since start on this path/,
    `the total counts both ladders, so it disagrees with the per-path figure beside it: ${line}`);
});
