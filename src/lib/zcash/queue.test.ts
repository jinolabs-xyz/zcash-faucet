import { test } from "node:test";
import assert from "node:assert/strict";

// Small capacity so the busy rejection is testable with three tasks in flight.
process.env.SEND_QUEUE_MAX_PENDING = "3";

const { getSendQueue, QueueFullError, TaskDeadlineError } = await import("./queue.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("tasks run strictly one at a time, in enqueue order", async () => {
  const q = getSendQueue();
  const spans: Array<{ id: number; start: number; end: number }> = [];
  const task = (id: number) => async () => {
    const start = Date.now();
    await sleep(30);
    spans.push({ id, start, end: Date.now() });
    return id;
  };
  const results = await Promise.all([q.run(task(1)), q.run(task(2)), q.run(task(3))]);

  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(spans.map((s) => s.id), [1, 2, 3], "completion order is enqueue order");
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i].start >= spans[i - 1].end, `task ${spans[i].id} started before ${spans[i - 1].id} finished`);
  }
});

test("the wallet lock holds under a concurrent burst: no overlap anywhere", async () => {
  const q = getSendQueue();
  let inFlight = 0;
  let maxInFlight = 0;
  const burst = [0, 1, 2].map(() =>
    q.run(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(15);
      inFlight--;
    }),
  );
  await Promise.all(burst);
  assert.equal(maxInFlight, 1, "two sends were building at once");
});

test("past capacity the queue sheds fast with QueueFullError", async () => {
  const q = getSendQueue();
  const slow = [0, 1, 2].map(() => q.run(() => sleep(80)));
  assert.equal(q.depth, 3);
  await assert.rejects(() => q.run(async () => {}), QueueFullError);
  await Promise.all(slow);
  // Drained: accepts work again.
  assert.equal(await q.run(async () => "again"), "again");
});

test("one failing task neither breaks the chain nor leaks depth", async () => {
  const q = getSendQueue();
  const failed = q.run(async () => {
    throw new Error("send exploded");
  });
  const after = q.run(async () => "still running");
  await assert.rejects(() => failed, /send exploded/);
  assert.equal(await after, "still running");
  assert.equal(q.depth, 0);
});

/* ── per-task deadline (#88) ──────────────────────────────────────────────── */

test("a task past its deadline gives the CALLER a TaskDeadlineError", async () => {
  const q = getSendQueue();
  const slow = q.run(() => sleep(200), 40);
  await assert.rejects(() => slow, TaskDeadlineError);
  await sleep(220); // let the real task drain so it does not bleed into the next test
});

test("the deadline does NOT release the wallet: the next task waits for the real one", async () => {
  // The whole point of #88. JS cannot cancel, so a timed-out task is still
  // building a transaction. If the deadline freed the slot, the next send would
  // select the same notes and we would double-spend, which is worse than the
  // stall the deadline was added to fix.
  const q = getSendQueue();
  let slowFinished = false;
  let nextStartedAt = 0;

  const slow = q.run(async () => {
    await sleep(160);
    slowFinished = true;
  }, 40);
  const next = q.run(async () => {
    nextStartedAt = Date.now();
    assert.equal(slowFinished, true, "the next task started while the timed-out task was STILL RUNNING");
    return "ok";
  });

  await assert.rejects(() => slow, TaskDeadlineError);
  assert.equal(slowFinished, false, "caller was answered before the task finished, which is the point");
  assert.equal(nextStartedAt, 0, "the next task must not have started yet");

  assert.equal(await next, "ok");
  assert.equal(slowFinished, true);
});

test("depth keeps counting a timed-out task, because the wallet is still busy", async () => {
  const q = getSendQueue();
  const slow = q.run(() => sleep(150), 40);
  await assert.rejects(() => slow, TaskDeadlineError);
  assert.equal(q.depth, 1, "reporting depth 0 here would advertise a free wallet that is not free");
  await sleep(170);
  assert.equal(q.depth, 0);
});

test("the deadline is armed when the task starts, not when it is enqueued", async () => {
  // Otherwise a task at the back of a busy queue is charged for the wait and
  // fails on arrival, so a surge would turn every queued drip into an unknown
  // outcome.
  const q = getSendQueue();
  const blocker = q.run(() => sleep(120));
  const behind = q.run(async () => "ran fine", 60); // 60ms deadline, ~120ms wait

  assert.equal(await behind, "ran fine");
  await blocker;
});

test("deadlineMs 0 disables the deadline entirely", async () => {
  const q = getSendQueue();
  assert.equal(await q.run(() => sleep(60).then(() => "slow but fine"), 0), "slow but fine");
});

test("a task that beats its deadline clears the timer", async () => {
  // A live timer would keep the event loop alive; node --test hanging after the
  // last assertion is how this would show up.
  const q = getSendQueue();
  assert.equal(await q.run(async () => "quick", 5_000), "quick");
  assert.equal(q.depth, 0);
});
