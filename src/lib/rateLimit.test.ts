import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, MAX_TRACKED_KEYS } from "./rateLimit.ts";

/** Clock in seconds, driven by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (s: number) => (t += s) };
}

test("allows up to max in a window, then refuses", () => {
  const c = clock();
  const rl = createRateLimiter({ windowSeconds: 60, max: 3, now: c.now });
  for (let i = 0; i < 3; i++) assert.equal(rl.check("a").allowed, true, `request ${i + 1} should pass`);
  assert.equal(rl.check("a").allowed, false);
});

test("the window rolls over and the key is served again", () => {
  const c = clock();
  const rl = createRateLimiter({ windowSeconds: 60, max: 2, now: c.now });
  rl.check("a");
  rl.check("a");
  assert.equal(rl.check("a").allowed, false);
  c.advance(60);
  assert.equal(rl.check("a").allowed, true);
});

test("keys are independent, so one heavy client cannot lock out another", () => {
  const c = clock();
  const rl = createRateLimiter({ windowSeconds: 60, max: 1, now: c.now });
  assert.equal(rl.check("a").allowed, true);
  assert.equal(rl.check("a").allowed, false);
  assert.equal(rl.check("b").allowed, true, "b was punished for a's traffic");
});

test("retryAfterSeconds counts down with the window and is never 0", () => {
  const c = clock();
  const rl = createRateLimiter({ windowSeconds: 60, max: 1, now: c.now });
  rl.check("a");
  assert.equal(rl.check("a").retryAfterSeconds, 60);
  c.advance(45);
  assert.equal(rl.check("a").retryAfterSeconds, 15);
  c.advance(14);
  // 1, not 0: a client told to retry in 0 seconds retries immediately and
  // gets another 429.
  assert.equal(rl.check("a").retryAfterSeconds, 1);
});

test("the default settings do NOT rate-limit our own receipt poll", () => {
  // page.tsx polls /api/tx every 10s while a receipt is visible, so 6/min per
  // tab. This is the check that stops someone tightening the default into a
  // limit that 429s the faucet's own UI.
  const c = clock();
  const rl = createRateLimiter({ windowSeconds: 60, max: 60, now: c.now });
  for (let minute = 0; minute < 10; minute++) {
    for (let poll = 0; poll < 6; poll++) {
      assert.equal(rl.check("one-tab").allowed, true, "the UI's own poll got limited");
      c.advance(10);
    }
  }
});

test("ten tabs behind one NAT still fit inside the default", () => {
  const c = clock();
  const rl = createRateLimiter({ windowSeconds: 60, max: 60, now: c.now });
  for (let poll = 0; poll < 6; poll++) {
    for (let tab = 0; tab < 10; tab++) {
      assert.equal(rl.check("shared-nat").allowed, true, `tab ${tab} poll ${poll} was limited`);
    }
    c.advance(10);
  }
});

test("rolled-over keys are swept, so the table does not grow forever", () => {
  const c = clock();
  const rl = createRateLimiter({ windowSeconds: 60, max: 5, now: c.now });
  for (let i = 0; i < 500; i++) rl.check(`key-${i}`);
  assert.equal(rl.size, 500);

  // A window later those are all stale. The next check sweeps them.
  c.advance(61);
  rl.check("someone-new");
  assert.equal(rl.size, 1, "stale windows were never dropped, which is a slow leak");
});

test("a full table fails OPEN rather than denying everyone", () => {
  // Filling this takes traffic from tens of thousands of distinct addresses.
  // Anyone with that many is not stopped by a per-IP limit anyway, and denying
  // would turn their flood into an outage for everybody else.
  const c = clock();
  const rl = createRateLimiter({ windowSeconds: 60, max: 1, now: c.now });
  for (let i = 0; i < MAX_TRACKED_KEYS; i++) rl.check(`flood-${i}`);
  assert.equal(rl.size, MAX_TRACKED_KEYS);

  const fresh = rl.check("an-innocent-bystander");
  assert.equal(fresh.allowed, true);
  assert.ok(rl.size <= MAX_TRACKED_KEYS + 1, "the table grew past its ceiling");
});

test("an already-tracked key is still limited when the table is full", () => {
  // Failing open must not become a way to buy unlimited lookups by first
  // filling the table.
  const c = clock();
  const rl = createRateLimiter({ windowSeconds: 60, max: 2, now: c.now });
  rl.check("heavy");
  rl.check("heavy");
  for (let i = 0; i < MAX_TRACKED_KEYS; i++) rl.check(`flood-${i}`);
  assert.equal(rl.check("heavy").allowed, false, "a tracked key escaped its limit once the table filled");
});
