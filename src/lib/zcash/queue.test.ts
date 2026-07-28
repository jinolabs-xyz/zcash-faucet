import { test } from "node:test";
import assert from "node:assert/strict";

// Small capacity so the busy rejection is testable with three tasks in flight.
process.env.SEND_QUEUE_MAX_PENDING = "3";

const { getSendQueue, QueueFullError } = await import("./queue.ts");

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
