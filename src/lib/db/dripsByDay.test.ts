/**
 * `drips.byDay`: the 30-day series the page draws, read from the same per-day counter
 * the totals come from.
 *
 * The ledger is SEEDED DIRECTLY into `drip_days` rather than served through the claim
 * path, for the reason drips.test.ts gives: the question here is what the window does
 * with rows that exist, and driving thirty days of real claims through the reserve path
 * would be thirty days of wall clock or a pile of fixtures that prove less.
 *
 * Time is injected everywhere. A test that asked what "today" is at assert time would go
 * red at a UTC midnight for a reason that has nothing to do with the code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-byday-")));
process.env.DB_BACKEND = "sqlite";

const { countDrips } = await import("./index.ts");
const { SqliteDriver } = await import("./driver.ts");

// Mid-day UTC so nothing here straddles a midnight by accident; the midnight case
// below asks for one deliberately.
const NOW_MS = Date.parse("2026-08-02T12:00:00Z");
const FIRST_DAY = "2026-07-04"; // 29 days before NOW: the oldest day in the window
const LAST_DAY = "2026-08-02"; // NOW itself

const raw = new SqliteDriver();
const plant = (day: string, sent: number, network = "taz") =>
  raw.run(`INSERT INTO drip_days (network, day, sent) VALUES (?, ?, ?)`, [network, day, sent]);
const sentOn = (byDay: { day: string; sent: number }[], day: string) =>
  byDay.find((d) => d.day === day)?.sent ?? null;

// Three days with counts, at both edges of the window and once in the middle, plus one
// row just outside it.
await plant(LAST_DAY, 3);
await plant("2026-07-28", 7);
await plant(FIRST_DAY, 42);
await plant("2026-07-03", 99);

test("the series is 30 UTC days, oldest first, with every quiet day zero-filled", async () => {
  const c = await countDrips(NOW_MS);
  assert.ok(c, "counter should answer");
  assert.equal(c.byDay.length, 30);
  assert.equal(c.byDay[0].day, FIRST_DAY, "oldest first");
  assert.equal(c.byDay[29].day, LAST_DAY, "today is last");

  // Contiguous, ascending, no day skipped: the gap between two entries is one day.
  for (let i = 1; i < c.byDay.length; i += 1) {
    const prev = Date.parse(`${c.byDay[i - 1].day}T00:00:00Z`);
    assert.equal(
      c.byDay[i].day,
      new Date(prev + 86_400_000).toISOString().slice(0, 10),
      `entry ${i} should be the day after entry ${i - 1}`,
    );
  }

  // Exactly the three planted days carry a count; the other twenty-seven are zeros
  // that were never written. A chart that dropped them would draw a busy month.
  assert.deepEqual(
    c.byDay.filter((d) => d.sent !== 0),
    [{ day: FIRST_DAY, sent: 42 }, { day: "2026-07-28", sent: 7 }, { day: LAST_DAY, sent: 3 }],
  );
  assert.equal(sentOn(c.byDay, "2026-07-05"), 0, "a day with no row is a zero, not a hole");
  assert.equal(sentOn(c.byDay, "2026-07-03"), null, "the day before the window is not in it");
});

test("the series sums to the 30-day total printed beside it", async () => {
  // The invariant a reader can check by eye. If these two ever disagree the page shows
  // a chart and a headline figure that contradict each other, and both look plausible.
  const c = await countDrips(NOW_MS);
  assert.ok(c);
  assert.equal(c.byDay.reduce((n, d) => n + d.sent, 0), c.last30d);
  assert.equal(c.last30d, 42 + 7 + 3);
  assert.equal(c.allTime, 42 + 7 + 3 + 99, "all-time still counts the row outside the window");
});

test("the window moves at UTC midnight and takes the oldest day with it", async () => {
  const beforeMidnight = Date.parse("2026-08-02T23:59:59.999Z");
  const afterMidnight = beforeMidnight + 1; // 2026-08-03T00:00:00.000Z

  const before = await countDrips(beforeMidnight);
  assert.ok(before);
  assert.equal(before.byDay[29].day, LAST_DAY, "one millisecond before midnight, today is the 2nd");
  assert.equal(before.byDay[29].sent, 3);
  assert.equal(before.byDay[0].day, FIRST_DAY);
  assert.equal(before.last30d, 42 + 7 + 3);

  const after = await countDrips(afterMidnight);
  assert.ok(after);
  assert.equal(after.byDay.length, 30, "the window is a fixed 30 days, not a growing one");
  assert.equal(after.byDay[29].day, "2026-08-03", "the new day joins as a zero");
  assert.equal(after.byDay[29].sent, 0);
  assert.equal(after.byDay[28].day, LAST_DAY, "yesterday keeps its count");
  assert.equal(after.byDay[28].sent, 3);
  assert.equal(after.byDay[0].day, "2026-07-05", "the oldest day drops off the back");
  assert.equal(sentOn(after.byDay, FIRST_DAY), null);
  assert.equal(after.last30d, 7 + 3, "and its 42 leaves the 30-day total with it");
});

test("a day outside the window cannot enter the series, in either direction", async () => {
  // A row dated in the future is only reachable through a clock that was ahead when it
  // was written. The series is built from the window and filled from the rows, never the
  // other way round, so such a row has nowhere to land.
  //
  // The 30-day TOTAL is a different statement: DRIP_TOTALS_SQL has no upper bound, so it
  // would count this row. That is pre-existing and not this change's to make - noted for
  // the CTO rather than fixed quietly inside a feature PR.
  await plant("2026-08-04", 13);
  const c = await countDrips(NOW_MS);
  assert.ok(c);
  assert.equal(c.byDay.length, 30);
  assert.equal(c.byDay[29].day, LAST_DAY, "the window still ends today");
  assert.equal(sentOn(c.byDay, "2026-08-04"), null, "a future-dated row is not in the last 30 days");
  assert.equal(sentOn(c.byDay, "2026-07-03"), null, "and neither is the day before the window");
});

test("each network draws its own series", async () => {
  // Mixed rows cannot be separated retroactively, which is why `network` is part of the
  // key. The cTAZ series must move on its own and leave TAZ where it was.
  const taz = await countDrips(NOW_MS, "taz");
  assert.ok(taz);
  await plant("2026-07-20", 5, "ctaz");

  const ctaz = await countDrips(NOW_MS, "ctaz");
  assert.ok(ctaz);
  assert.equal(ctaz.byDay.length, 30);
  assert.equal(sentOn(ctaz.byDay, "2026-07-20"), 5);
  assert.equal(sentOn(ctaz.byDay, LAST_DAY), 0, "the TAZ drips are not in the cTAZ series");

  const tazAgain = await countDrips(NOW_MS, "taz");
  assert.ok(tazAgain);
  assert.deepEqual(tazAgain.byDay, taz.byDay, "the TAZ series must not move");
  assert.equal(sentOn(tazAgain.byDay, "2026-07-20"), 0);
});

test("an entry is a day and a count and nothing else", async () => {
  // The privacy pin, and the reason this reads drip_days rather than claims: there is no
  // per-visitor anything in this table to leak, and a future edit that adds a field here
  // has to come past this assertion first.
  const c = await countDrips(NOW_MS);
  assert.ok(c);
  for (const entry of c.byDay) {
    assert.deepEqual(Object.keys(entry).sort(), ["day", "sent"]);
    assert.match(entry.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(Number.isInteger(entry.sent) && entry.sent >= 0, true, `bad count ${entry.sent}`);
  }
});
