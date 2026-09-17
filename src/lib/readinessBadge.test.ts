import { test } from "node:test";
import assert from "node:assert/strict";
import { readinessBadge, CHECKING_BADGE, mutedInk, type ReadinessInput } from "./readinessBadge.ts";

/**
 * ONE ROW PER STATE, PINNING THE WORD AND THE DOT (#573).
 *
 * The point of extracting this was that the decision MOVES and does not change, and the only way
 * to say that with a straight face is to pin every phase before and after. A table also makes the
 * two-dimensional cases visible: `queued` is PREPARING or NOT READY depending on what it is queued
 * behind, and `empty` is EMPTY or TOPPING UP depending on whether a refill is running. Those two
 * pairs are the whole reason this is not a lookup table keyed on phase alone.
 */
const LIVE = { fill: "var(--color-live)", ring: "var(--color-live)" };
const RED = { fill: "var(--color-empty)", ring: "var(--color-empty)" };
const CALM = { fill: "transparent", ring: mutedInk(45) };
const ACCENT = { fill: "var(--color-accent)", ring: "var(--color-accent)" };

const base: ReadinessInput = { phase: "ready", queuedBehindFault: false, refilling: false, live: true };

const CASES: Array<[string, Partial<ReadinessInput>, string, { fill: string; ring: string }]> = [
  ["checking says so and raises no alarm", { phase: "checking", live: false }, "CHECKING", CALM],
  ["a fault is NOT READY and red", { phase: "fault", live: false }, "NOT READY", RED],
  ["syncing is PREPARING with no alarm", { phase: "syncing", live: false }, "PREPARING", CALM],
  ["queued behind a sync is PREPARING", { phase: "queued", live: false }, "PREPARING", CALM],
  ["queued behind a FAULT is NOT READY, not PREPARING",
    { phase: "queued", queuedBehindFault: true, live: false }, "NOT READY", RED],
  ["empty with no refill running is EMPTY", { phase: "empty", live: false }, "EMPTY", RED],
  ["empty WITH a refill running is TOPPING UP, and calm rather than red",
    { phase: "empty", refilling: true, live: false }, "TOPPING UP", ACCENT],
  ["degraded says DEGRADED and shows red", { phase: "degraded", live: false }, "DEGRADED", RED],
  ["ready is LIVE", { phase: "ready" }, "LIVE", LIVE],
  ["submitting is still LIVE", { phase: "submitting" }, "LIVE", LIVE],
  ["success is still LIVE", { phase: "success" }, "LIVE", LIVE],
  ["cooldown is still LIVE", { phase: "cooldown" }, "LIVE", LIVE],
  ["error is LIVE by word but not by dot when nothing is live",
    { phase: "error", live: false }, "LIVE", CALM],
];

for (const [name, patch, word, dot] of CASES) {
  test(`#573: ${name}`, () => {
    const got = readinessBadge({ ...base, ...patch });
    assert.equal(got.word, word);
    assert.deepEqual(got.dot, dot);
  });
}

/**
 * THE ANTI-DRIFT ROW, and it is the reason the constant is derived rather than written. Shell.tsx
 * used to hand-write CHECKING_BADGE with a ring string byte-identical to `mutedInk(45)` - a second
 * copy that nothing tied to the first, so changing the checking case here would have left four
 * subpages on the old one silently.
 */
test("#573: CHECKING_BADGE is the checking case, not a second copy of it", () => {
  assert.deepEqual(
    CHECKING_BADGE,
    readinessBadge({ phase: "checking", queuedBehindFault: false, refilling: false, live: false }),
  );
  assert.equal(CHECKING_BADGE.word, "CHECKING");
});

/** `live` decides the DOT and never the word - a fault is red whatever the page thinks. */
test("#573: live moves the dot and not the word", () => {
  const a = readinessBadge({ ...base, phase: "ready", live: true });
  const b = readinessBadge({ ...base, phase: "ready", live: false });
  assert.equal(a.word, b.word, "same phase, same word");
  assert.notDeepEqual(a.dot, b.dot, "and the dot is what live changes");
});
