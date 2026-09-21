/**
 * The node-status read: how long we wait for our own node before calling its height unknown.
 *
 * A timeout here is not a performance setting, it is a CLAIM about the node - past it the page
 * tells a visitor "our node did not report its height just now, so we are not sending", and
 * refuses the claim. Setting it below what the node actually takes turns a healthy faucet into
 * an intermittently broken one, which is what happened on 2026-09-19.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// NO REAL ORACLE FROM A UNIT TEST. Both legs: HOSH_URL to a closed port seals the aggregate,
// TIP_ORACLE_ENDPOINT set EMPTY seals the direct gRPC leg, which defaults to testnet.zec.rocks
// when merely unset (config.ts:140). Before any import that loads config. Enforced by
// zcash/oraclePin.test.ts.
process.env.HOSH_URL = "http://127.0.0.1:9/";
process.env.TIP_ORACLE_ENDPOINT = "";

/* ── the timeout is a claim about the node ────────────────────────────── */

test("the node-status timeout defaults above what production actually takes", async () => {
  // MEASURED ON PROD, 2026-09-19: ten samples of /api/status split either side of 4s - answers at
  // 0.9/0.9/1.4/1.9/1.9/2.4/2.8/3.0s carried a node, and 4.8s and 6.7s carried node: null. The old
  // 4000 sat inside the real spread, so roughly one claim in four was refused with "our node did
  // not report its height just now" while the node was healthy and 100% synced.
  const { nodeStatusTimeoutMs } = await import("./nodeStatus.ts");
  delete process.env.FAUCET_NODE_STATUS_TIMEOUT_MS;
  assert.ok(nodeStatusTimeoutMs() > 6_700,
    `the default must clear the slowest reading we have actually seen; got ${nodeStatusTimeoutMs()}`);
});

test("a broken override cannot disable the status read, which would look like an outage", async () => {
  // THE FLOOR IS THE POINT. A timeout of 0 aborts before the node can answer, so EVERY claim is
  // refused with a sentence about the node - a configuration mistake that presents as a node
  // fault and sends whoever reads it to the wrong machine.
  const { nodeStatusTimeoutMs } = await import("./nodeStatus.ts");
  for (const bad of ["0", "-1", "abc", "", "500"]) {
    process.env.FAUCET_NODE_STATUS_TIMEOUT_MS = bad;
    assert.ok(nodeStatusTimeoutMs() >= 1000, `"${bad}" must not fall below the floor`);
  }
  // And a DELIBERATE value is honoured, so the floor is not just ignoring the variable.
  process.env.FAUCET_NODE_STATUS_TIMEOUT_MS = "15000";
  assert.equal(nodeStatusTimeoutMs(), 15_000);
  delete process.env.FAUCET_NODE_STATUS_TIMEOUT_MS;
});

test("the retry is bounded by a shared budget, not multiplied by the attempts", async () => {
  // THE OWNER ASKED FOR "7 seconds, 3 times". Three full-length attempts is the shape to avoid:
  // 21-36s of a visitor's time spent reaching the same refusal, and three requests to a backend
  // that is slow BECAUSE it is loaded is how a wobble becomes an outage. So the attempts SHARE
  // the budget rather than each getting it.
  const { nodeStatusAttemptsMs, nodeStatusTimeoutMs } = await import("./nodeStatus.ts");
  delete process.env.FAUCET_NODE_STATUS_TIMEOUT_MS;
  const a = nodeStatusAttemptsMs();
  assert.equal(a.reduce((x, y) => x + y, 0), nodeStatusTimeoutMs(),
    "the attempts must sum to the budget, never exceed it");
  assert.ok(a.length >= 2, "one attempt is not a retry");

  // FAST FIRST, PATIENT SECOND. Eight of ten production samples answered under 3s, so the first
  // attempt is cut short: a healthy faucet loses nothing, and a slow one has spent little before
  // the attempt that is actually likely to succeed. Reversed, every visitor waits for the slow
  // path before the fast one is ever tried.
  assert.ok(a[0] < a[a.length - 1], `the first attempt must be the short one; got ${JSON.stringify(a)}`);
  // And the patient attempt must clear the slowest reading we have actually seen on prod (6.7s),
  // or the retry adds latency without adding a success.
  assert.ok(a[a.length - 1] > 6_700, `the patient attempt must clear 6.7s; got ${a[a.length - 1]}`);
});

test("a tiny budget still yields attempts that can reach a node", async () => {
  // The floor interacts with the split: a budget divided into attempts must not produce a first
  // attempt of 0ms, which would abort before the request left and burn a retry on nothing.
  const { nodeStatusAttemptsMs } = await import("./nodeStatus.ts");
  process.env.FAUCET_NODE_STATUS_TIMEOUT_MS = "1000";
  const a = nodeStatusAttemptsMs();
  assert.ok(a.every((ms) => ms >= 0), JSON.stringify(a));
  assert.ok(a[0] >= 1000, `the first attempt must still be able to reach the node; got ${a[0]}`);
  delete process.env.FAUCET_NODE_STATUS_TIMEOUT_MS;
});

test("a page and a claim are two different people waiting for two different reasons", async () => {
  const { nodeStatusAttemptsMs, nodeStatusBudgetMs } = await import("./nodeStatus.ts");
  delete process.env.FAUCET_NODE_STATUS_TIMEOUT_MS;

  // THE CLAIM IS PATIENT. Someone pressed a button and expects work; being refused because we
  // gave up at 4s is the outage this whole branch is about.
  const claim = nodeStatusAttemptsMs("claim");
  assert.ok(claim.length >= 2, "a claim retries");
  assert.ok(claim.reduce((a, b) => a + b, 0) > 6_700, "and clears the slowest prod reading");

  // THE PAGE IS FAST. Someone just arrived; a status card that takes twelve seconds to fill
  // reads as a broken site, and a fast unknown they can act on beats a slow one.
  const page = nodeStatusAttemptsMs("page");
  assert.equal(page.length, 1, "a page does not retry - it would only be slower to say the same");
  assert.ok(nodeStatusBudgetMs("page") < nodeStatusBudgetMs("claim"),
    "the page must not inherit the claim's patience - raising the claim budget is what made the page slow");

  // AND THE PAGE STILL CLEARS THE COMMON CASE. Eight of ten prod samples answered under 3s, so a
  // fast page is not a page that gives up on a healthy node.
  assert.ok(page[0] >= 3_000, `the page must still reach a healthy node; got ${page[0]}`);
});


test("an HTTP error is a FAILED ATTEMPT, not a fast read - measured through the real function", async () => {
  // M-i survived without this row: every other test in this file exercises the pure config
  // helpers, so nothing here had ever driven getNodeStatus itself, and the ok-check could be
  // deleted with the suite still green. A 500 comes back in single-digit ms and carries no wallet
  // work; bucketed, it is the fastest read we have ever recorded and it answers SDE-Research's
  // question with the speed of the error path.
  const { getNodeStatus } = await import("./nodeStatus.ts");
  const { nodeStatusLatency, resetNodeStatusFailures } = await import("./nodeStatusFailure.ts");
  const realFetch = globalThis.fetch;
  resetNodeStatusFailures();
  let asked = 0;
  globalThis.fetch = (async () => {
    asked += 1;
    return new Response('{"error":"boom"}', { status: 500, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await getNodeStatus("page");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(asked > 0, "the stub was never called, so this row measured nothing");
  const v = nodeStatusLatency("page");
  const bucketed = Object.values(v.buckets).reduce((a, b) => a + b, 0);
  assert.equal(bucketed, 0, `an HTTP 500 landed in a latency bucket: ${JSON.stringify(v.buckets)}`);
  assert.equal(v.failedAttempts, asked, "the failed attempt was not counted");
});


test("a refused connection is a failed attempt too, however fast it comes back", async () => {
  // The other half of the same rule, and the one App's 4.27s null is made of: a second attempt
  // that dies instantly. Bucketed, it is indistinguishable from the node answering in 3ms.
  const { getNodeStatus } = await import("./nodeStatus.ts");
  const { nodeStatusLatency, resetNodeStatusFailures } = await import("./nodeStatusFailure.ts");
  const realFetch = globalThis.fetch;
  resetNodeStatusFailures();
  let asked = 0;
  globalThis.fetch = (async () => {
    asked += 1;
    throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" });
  }) as typeof fetch;
  try {
    await getNodeStatus("page");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(asked > 0, "the stub was never called, so this row measured nothing");
  const v = nodeStatusLatency("page");
  const bucketed = Object.values(v.buckets).reduce((a, b) => a + b, 0);
  assert.equal(bucketed, 0, `a refused connection landed in a latency bucket: ${JSON.stringify(v.buckets)}`);
  assert.equal(v.failedAttempts, asked, `every refused attempt is counted; asked ${asked}, counted ${v.failedAttempts}`);
  assert.equal(v.censoredAtOurDeadline, 0, "a refusal is not a censored read - we did not give up, it did");
});


test("a timeout is CENSORED, not a failed attempt, and the classifier is what decides", async () => {
  // The distinction SDE-Research asked for, measured where it is actually made. A censored read
  // has no duration we may quote - we stopped listening - while a failed attempt does. Counting a
  // timeout as a failure would give it a "fastest-failure" made of our own patience.
  const { getNodeStatus } = await import("./nodeStatus.ts");
  const { nodeStatusLatency, resetNodeStatusFailures } = await import("./nodeStatusFailure.ts");
  const realFetch = globalThis.fetch;
  resetNodeStatusFailures();
  let asked = 0;
  globalThis.fetch = (async () => {
    asked += 1;
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  }) as typeof fetch;
  try {
    await getNodeStatus("page");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(asked > 0, "the stub was never called, so this row measured nothing");
  const v = nodeStatusLatency("page");
  assert.equal(v.censoredAtOurDeadline, asked, `every timeout is censored; asked ${asked}, censored ${v.censoredAtOurDeadline}`);
  assert.equal(v.failedAttempts, 0, "a timeout was counted as a failed attempt, which gives it a duration it does not have");
  assert.equal(v.fastestFailureMs, null, "our own deadline became a 'fastest failure'");
});


test("the shape line speaks during a total outage, not only when a read succeeds", async () => {
  // It was reported on the success path alone. A node failing every read would print its failure
  // CLASS and never the shape - so "censored 40, recovered 0" existed and was unreadable in the one
  // state anybody would want it. A reporter that goes quiet as things get worse is the same fault
  // as a check that reports by silence.
  const { getNodeStatus } = await import("./nodeStatus.ts");
  const { resetNodeStatusFailures } = await import("./nodeStatusFailure.ts");
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const said: string[] = [];
  resetNodeStatusFailures();
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" });
  }) as typeof fetch;
  console.warn = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  try {
    await getNodeStatus("page");
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
  const shape = said.filter((l) => l.includes("[node-status] shape"));
  assert.equal(shape.length, 1, `the shape never spoke during an all-failure read: ${JSON.stringify(said)}`);
  assert.match(shape[0], /failed-attempts=[1-9]/, `it spoke without saying what failed: ${shape[0]}`);
});


test("censored counts ATTEMPTS, not calls - an aborted first attempt is counted even when the call then succeeds", async () => {
  // SDE-Research's discriminator rests on this and nothing else states it. Their two candidate
  // explanations for the remaining production nulls are separated by the RATIO of censored to
  // failed-attempts: near parity means attempt one always times out, failed-attempts running ahead
  // means some calls fail fast twice. If censored only counted whole abandoned calls, an aborted
  // first attempt inside a call that then succeeded would be invisible and the ratio would collapse
  // - so this is pinned here rather than left true by accident.
  const { getNodeStatus } = await import("./nodeStatus.ts");
  const { nodeStatusLatency, resetNodeStatusFailures } = await import("./nodeStatusFailure.ts");
  const realFetch = globalThis.fetch;
  resetNodeStatusFailures();
  let asked = 0;
  globalThis.fetch = (async () => {
    asked += 1;
    if (asked === 1) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await getNodeStatus("claim");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(asked, 2, "the claim path must have retried once for this row to mean anything");
  const v = nodeStatusLatency("claim");
  assert.equal(v.censoredAtOurDeadline, 1, "the aborted FIRST attempt was not counted - censored is counting calls, not attempts");
  assert.equal(v.recoveredOnRetry, 1, "the second attempt answered, so this call was rescued");
  assert.equal(v.failedAttempts, 0, "nothing failed below our deadline here");
});


test("both ladders get their own failure line, driven through the real function", async () => {
  // M-x survived without this: the row that checks per-path throttling calls the recorder directly,
  // so removing `purpose` from the CALL SITE changed nothing any row could see. The wiring is a
  // separate claim from the recorder's behaviour and needs its own measurement.
  const { getNodeStatus } = await import("./nodeStatus.ts");
  const { resetNodeStatusFailures } = await import("./nodeStatusFailure.ts");
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const said: string[] = [];
  resetNodeStatusFailures();
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" });
  }) as typeof fetch;
  console.warn = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  try {
    await getNodeStatus("page");
    await getNodeStatus("claim");
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
  const failures = said.filter((l) => l.includes("read failed"));
  assert.ok(failures.some((l) => /on the page path/.test(l)), `no page failure line: ${JSON.stringify(said)}`);
  assert.ok(failures.some((l) => /on the claim path/.test(l)),
    `the claim failure was swallowed by the page one - same class, different ladder: ${JSON.stringify(said)}`);
});


test("the PAGE budget can never exceed the CLAIM budget, at any configured knob", async () => {
  // @SDE-Infra, #688 retro. `Math.max(4000, ...)` was unconditional, so a knob in [1000, 4000) gave
  // the page MORE patience than the claim - configured 3000 produced page 4000 against claim 3000 -
  // inverting the design the function's own comment states, and starving the claim path while an
  // operator believed they were making the page snappier.
  const { nodeStatusBudgetMs } = await import("./nodeStatus.ts");
  for (const knob of ["1000", "1500", "2999", "3000", "3999", "4000", "5000", "6000", "12000", "20000"]) {
    process.env.FAUCET_NODE_STATUS_TIMEOUT_MS = knob;
    const claim = nodeStatusBudgetMs("claim");
    const page = nodeStatusBudgetMs("page");
    assert.ok(page <= claim, `knob ${knob}: page ${page} exceeds claim ${claim} - the page is more patient than the claim`);
  }
  delete process.env.FAUCET_NODE_STATUS_TIMEOUT_MS;
});

test("and the page is still CAPPED, so removing the floor did not remove the ceiling", async () => {
  // The pair. Without this, `page = budget` would satisfy the row above at every knob and quietly
  // hand the page the full claim budget - which is the thing #692 and #698 were about.
  const { nodeStatusBudgetMs } = await import("./nodeStatus.ts");
  process.env.FAUCET_NODE_STATUS_TIMEOUT_MS = "20000";
  assert.equal(nodeStatusBudgetMs("page"), 6000, "a large claim budget must not raise the page past 6000");
  process.env.FAUCET_NODE_STATUS_TIMEOUT_MS = "12000";
  assert.equal(nodeStatusBudgetMs("page"), 6000);
  delete process.env.FAUCET_NODE_STATUS_TIMEOUT_MS;
});

test("an http failure on the PAGE ladder does not silence one on the CLAIM ladder", async () => {
  // @SDE-App, #696 retro. nodeStatus.ts:233 passed no scope, so it defaulted to "claim" and keyed
  // http:claim. A page-path 500 then started a 60s throttle that swallowed a genuine claim-path 500
  // seconds later - exactly what the per-path key was added to prevent, on two of three call sites.
  const { getNodeStatus } = await import("./nodeStatus.ts");
  const { resetNodeStatusFailures } = await import("./nodeStatusFailure.ts");
  const realFetch = globalThis.fetch; const realWarn = console.warn;
  const said: string[] = [];
  resetNodeStatusFailures();
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  console.warn = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  try {
    await getNodeStatus("page");
    await getNodeStatus("claim");
  } finally { globalThis.fetch = realFetch; console.warn = realWarn; }
  const fails = said.filter((l) => l.includes("read failed: http"));
  assert.ok(fails.some((l) => /on the page path/.test(l)), `no page-path http line: ${JSON.stringify(said)}`);
  assert.ok(fails.some((l) => /on the claim path/.test(l)),
    `the claim-path http failure was swallowed by the page-path throttle: ${JSON.stringify(said)}`);
});

test("a parse failure on the PAGE ladder does not silence one on the CLAIM ladder", async () => {
  // The same defect at nodeStatus.ts:242. A 200 carrying neither height is a different fault from a
  // 500, and it had the same missing argument.
  const { getNodeStatus } = await import("./nodeStatus.ts");
  const { resetNodeStatusFailures } = await import("./nodeStatusFailure.ts");
  const realFetch = globalThis.fetch; const realWarn = console.warn;
  const said: string[] = [];
  resetNodeStatusFailures();
  globalThis.fetch = (async () => new Response(JSON.stringify({ result: {} }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
  console.warn = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  try {
    await getNodeStatus("page");
    await getNodeStatus("claim");
  } finally { globalThis.fetch = realFetch; console.warn = realWarn; }
  const fails = said.filter((l) => l.includes("read failed: parse"));
  assert.ok(fails.some((l) => /on the page path/.test(l)), `no page-path parse line: ${JSON.stringify(said)}`);
  assert.ok(fails.some((l) => /on the claim path/.test(l)),
    `the claim-path parse failure was swallowed by the page-path throttle: ${JSON.stringify(said)}`);
});
