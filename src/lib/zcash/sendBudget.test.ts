import { test } from "node:test";
import assert from "node:assert/strict";
import { POLL_RETRIES, senderWorstCaseMs, defaultTaskDeadlineMs, DEADLINE_MARGIN_MS } from "./sendBudget.ts";

/** Stock defaults from config.ts, so the numbers below are the shipped ones. */
const STOCK = { opTimeoutMs: 180_000, rpcTimeoutMs: 15_000, pollMs: 1_500 };

test("the shipped worst case is 279s, not the 195s you get from op + rpc", () => {
  // 2 head rpcs + 1 tail rpc + POLL_RETRIES in the final poll overrun = 6 rpcs
  // at 15s, plus 1x+2x+3x pollMs of backoff, plus the 180s poll loop.
  assert.equal(senderWorstCaseMs(STOCK), 279_000);

  // The number this replaced. Keeping it in the test because a backstop set here
  // fires DURING a legitimate slow send, and the whole failure mode of #88 is a
  // false unknown outcome costing someone a cooldown for coins they received.
  const naive = STOCK.opTimeoutMs + STOCK.rpcTimeoutMs;
  assert.ok(naive < senderWorstCaseMs(STOCK), "op + rpc sits inside the legitimate range");
});

test("the default deadline sits above the worst case, never inside it", () => {
  assert.equal(defaultTaskDeadlineMs(STOCK), 279_000 + DEADLINE_MARGIN_MS);
  assert.ok(defaultTaskDeadlineMs(STOCK) > senderWorstCaseMs(STOCK));
});

test("raising the operator's op timeout moves the backstop with it", () => {
  // The reason this is derived and not a literal. A hardcoded 309s would start
  // firing early the moment someone raised ZALLET_OP_TIMEOUT_MS for a slow box.
  const raised = { ...STOCK, opTimeoutMs: 600_000 };
  assert.ok(
    defaultTaskDeadlineMs(raised) > senderWorstCaseMs(raised),
    "the backstop must stay above the sender's own bound at any op timeout",
  );
  assert.equal(defaultTaskDeadlineMs(raised) - defaultTaskDeadlineMs(STOCK), 420_000);
});

test("raising rpc timeout or poll interval also moves it", () => {
  // Both feed the poll-loop overrun, so neither can be ignored.
  const slowRpc = { ...STOCK, rpcTimeoutMs: 30_000 };
  const slowPoll = { ...STOCK, pollMs: 5_000 };
  assert.ok(senderWorstCaseMs(slowRpc) > senderWorstCaseMs(STOCK));
  assert.ok(senderWorstCaseMs(slowPoll) > senderWorstCaseMs(STOCK));
});

test("POLL_RETRIES is the single source the sender also uses", () => {
  // zalletsend.ts imports this rather than declaring its own. If someone
  // reintroduces a local copy there, the arithmetic above silently stops
  // matching the code it describes.
  assert.equal(POLL_RETRIES, 3);
});
