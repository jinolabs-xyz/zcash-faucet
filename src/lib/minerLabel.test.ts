/**
 * The miner wording, and every case is a sentence someone could be misled by.
 *
 * The bug behind this file: the panel said "miner on" for 70 minutes while the miner
 * errored every 5 seconds. So the tests are mostly about what a line must NOT say.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { minerRow, minerChip, minerErrorRow, humanAge, readingFromStatus } from "./minerLabel.ts";
import type { MinerReading } from "./miner/heartbeat.ts";

const base: MinerReading = {
  state: "running",
  beatAgoSeconds: 2,
  templateAgoSeconds: 20,
  lastTemplateHeight: 4_221_033,
  mode: "submit",
  lastErrorStage: null,
  consecutiveErrors: 0,
};

test("running names the age and the height, because 'on' was the whole problem", () => {
  const s = minerRow(base);
  assert.match(s, /mining/);
  assert.match(s, /20s ago/);
  assert.match(s, /4,221,033/);
});

test("THE 70 MINUTE OUTAGE does not read as survivable", () => {
  const s = minerRow({ ...base, state: "stalled", templateAgoSeconds: 70 * 60 });
  assert.match(s, /NO TEMPLATE/);
  assert.match(s, /70 min/, "the age is the point, 'no template' alone reads like a quiet minute");
  assert.doesNotMatch(s, /\bmining\b/, "must not contain the healthy word");
  assert.doesNotMatch(s, /^on$|\bok\b/i);
});

test("a miner that never fetched a template says so, and does not say 0s", () => {
  const s = minerRow({ ...base, state: "stalled", templateAgoSeconds: null, lastTemplateHeight: null });
  assert.match(s, /NO TEMPLATE since the miner started/);
  assert.doesNotMatch(s, /0s|0 min/, "a null age must never render as zero");
});

test("not-writing is distinct from stalled, because the fault is somewhere else", () => {
  const s = minerRow({ ...base, state: "not-writing", beatAgoSeconds: 12 * 60 });
  assert.match(s, /NO HEARTBEAT/);
  assert.match(s, /12 min/);
  assert.match(s, /unknown/, "the miner itself may be fine, we cannot see it");
  assert.notEqual(s, minerRow({ ...base, state: "stalled", templateAgoSeconds: 12 * 60 }));
});

test("cannot-verify is never 'off' and never healthy", () => {
  const s = minerRow({ ...base, state: "cannot-verify", beatAgoSeconds: null, templateAgoSeconds: null, lastTemplateHeight: null });
  assert.match(s, /cannot tell/);
  assert.doesNotMatch(s, /\boff\b/, "we have not established it is off, only that we cannot see it");
  assert.doesNotMatch(s, /\bmining\b/);
});

test("proposal mode does not claim we are trying to win blocks", () => {
  const s = minerRow({ ...base, mode: "proposal" });
  assert.match(s, /proposing only/);
  assert.doesNotMatch(s, /\bmining\b/, "a proposal-mode miner never submits a solved block");
});

test("every bad state is visibly bad in the terse strip too", () => {
  assert.equal(minerChip(base), "mining");
  for (const state of ["stalled", "not-writing", "cannot-verify"] as const) {
    const chip = minerChip({ ...base, state });
    assert.doesNotMatch(chip, /^on$|mining/, `${state} chip reads healthy: ${chip}`);
    // "off" would be wrong for all three: stalled and not-writing are running and
    // failing, and cannot-verify is unseen. They need different operator responses.
    assert.doesNotMatch(chip, /^off$/, `${state} chip claims deliberate off: ${chip}`);
  }
});

test("the four chips are four different words", () => {
  const all = (["running", "stalled", "not-writing", "cannot-verify"] as const).map((state) => minerChip({ ...base, state }));
  assert.equal(new Set(all).size, 4, `states collapsed in the strip: ${all.join(", ")}`);
});

test("the terse chip does not overstate proposal mode either", () => {
  // Caught in a browser, not by a test: the strip said "mining" while the panel one
  // click away said "proposing only". Terse is not licence to claim more.
  assert.equal(minerChip({ ...base, mode: "proposal" }), "proposing");
  assert.doesNotMatch(minerChip({ ...base, mode: "proposal" }), /mining/);
});

test("errors are reported separately and never invent a state", () => {
  assert.equal(minerErrorRow({ ...base, lastErrorStage: null }), null);

  const many = minerErrorRow({ ...base, lastErrorStage: "getblocktemplate", consecutiveErrors: 840 });
  assert.ok(many, "a stage token must produce a line");
  assert.match(many, /840 in a row/);

  const one = minerErrorRow({ ...base, lastErrorStage: "solve", consecutiveErrors: 1 });
  assert.ok(one);
  assert.match(one, /last error in solve/);
});

test("the error line carries a stage token, so no message can leak through it", () => {
  // The reason this is a token and not text: the miner's raw errors are the
  // transport's and can include the RPC URL, which can carry credentials in its
  // userinfo. This endpoint is public.
  const s = minerErrorRow({ ...base, lastErrorStage: "getblocktemplate", consecutiveErrors: 3 });
  assert.ok(s);
  assert.doesNotMatch(s, /https?:|@|:\/\//, "nothing URL-shaped may reach the panel");
});

/* ---------- reading the payload, including one an older deploy would send --------- */

test("AN OLD DEPLOY sending only { active: true } is cannot-verify, not running", () => {
  // The upgrade hazard. Deriving state from `active`, or defaulting it to running,
  // rebuilds the original bug against any box that has not been redeployed yet.
  const r = readingFromStatus({ active: true });
  assert.equal(r.state, "cannot-verify");
  assert.doesNotMatch(minerRow(r), /\bmining\b/);
});

test("a missing or unknown state is never trusted", () => {
  for (const state of [undefined, null, "", "on", "ok", "RUNNING", "cannot-verify"]) {
    assert.equal(readingFromStatus({ state } as never).state, "cannot-verify", `state ${state}`);
  }
  assert.equal(readingFromStatus(undefined).state, "cannot-verify");
  assert.equal(readingFromStatus(null).state, "cannot-verify");
});

test("the three real states pass through untouched", () => {
  for (const state of ["running", "stalled", "not-writing"] as const) {
    assert.equal(readingFromStatus({ state, active: false }).state, state);
  }
});

test("absent ages stay null rather than becoming zero", () => {
  const r = readingFromStatus({ state: "running" });
  assert.equal(r.templateAgoSeconds, null);
  assert.equal(r.beatAgoSeconds, null);
  // A running miner with no age we can quote must say so, not claim "0s ago".
  assert.match(minerRow(r), /unknown/);
});

test("ages round coarsely and do not pretend to precision", () => {
  assert.equal(humanAge(0), "0s");
  assert.equal(humanAge(20), "20s");
  assert.equal(humanAge(89), "89s");
  assert.equal(humanAge(90), "2 min");
  assert.equal(humanAge(70 * 60), "70 min");
  assert.equal(humanAge(3 * 3600), "3 h");
});
