#!/usr/bin/env node
/**
 * Plant a 30-day drip history so ui-smoke watches a chart shaped like the one we run.
 *
 * WHY THIS EXISTS. CI creates data/faucet.db fresh for the job, and the only drips in it are the
 * ones ui-smoke's own claim makes - all dated today. So `countingSince` is TODAY, the other 29 days
 * of the window are before the counter existed, and since #677 the chart correctly draws NOTHING
 * for them. The suite was therefore judging a ONE-BAR chart: every row about the drips plot, the
 * sparkline and the figures beside them was measuring a fresh install, which is a shape we do not
 * run anywhere. Production, measured 2026-09-18: countingSince 2026-08-01 against a window opening
 * 2026-08-20, so ZERO uncounted days and thirty drawn bars. The instrument did not resemble its
 * subject, and that mismatch is what let three #594 rows pass for years on an assumption about
 * where a bar would be.
 *
 * THE START DATE IS A DECISION, NOT A CONSTANT, and this is the line to read before changing it.
 * The window is the last 30 days. Seeding from its FIRST day means every plotted day is counted,
 * which is what production looks like. Move the start one day LATER and the earliest day becomes
 * uncounted, the chart goes part-blank, and rows that assume a drawn bar start failing - move it
 * EARLIER and nothing changes at all. Either way no row goes red to tell you the coverage moved,
 * so the value is chosen here deliberately and the reasoning stays with it.
 *
 * AND IT DOES NOT SUBSTITUTE FOR DRIVING A STATE. #677's own behaviour - a day before counting
 * began, drawn as nothing and named "not counted" - has NO day to happen on in a fully counted
 * window. ui-smoke's #594 block supplies its own series through page.route for exactly that
 * reason, and those rows are unaffected by whether this script ran. Measured both ways: 414 ok /
 * 0 FAIL with this fixture and without it, not one row changing outcome.
 *
 * SAFETY. This refuses to touch a counter that already holds anything. A real database has
 * history; an empty one is a fixture waiting to be made. That check is what makes it safe for this
 * file to exist in a repo whose production box runs the same code.
 *
 *   node scripts/seed-drips.mjs <path-to-faucet.db>
 *
 * The app must have STARTED first: it owns the schema, and creating the table here would be a
 * second copy of it, free to drift from the one in sql.ts.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const dbPath = process.argv[2];
const DAYS = 30;
const NETWORK = "taz";

if (!dbPath) {
  console.error("seed-drips: needs the database path, e.g. node scripts/seed-drips.mjs data/faucet.db");
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`seed-drips: ${dbPath} does not exist. Start the app first - it owns the schema.`);
  process.exit(2);
}

const Database = require("better-sqlite3");
const db = new Database(dbPath);

// The app owns the schema. If the table is missing, the app has not run, and planting rows into a
// table we invented here would be a second definition of it.
const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='drip_days'").get();
if (!table) {
  console.error("seed-drips: drip_days does not exist yet. Start the app and let it answer once first.");
  process.exit(2);
}

const existing = db.prepare("SELECT COUNT(*) AS n, MIN(day) AS lo, MAX(day) AS hi FROM drip_days").get();
if (existing.n > 0) {
  // REFUSED, NOT MERGED INTO. A counter with rows is either production or a run that already
  // happened, and "seed on top of whatever is there" is how a fixture silently becomes real data.
  console.error(`seed-drips: REFUSING - drip_days already holds ${existing.n} row(s), ${existing.lo} to ${existing.hi}.`);
  console.error("seed-drips: this plants a fixture into an EMPTY counter and will not touch one with history.");
  process.exit(1);
}

const today = new Date();
const day = (back) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back))
  .toISOString()
  .slice(0, 10);

const insert = db.prepare("INSERT INTO drip_days (network, day, sent) VALUES (?, ?, ?)");
const rows = [];
for (let back = DAYS - 1; back >= 0; back--) {
  // Deterministic and uneven, so the chart has a shape and the axis top is a real maximum rather
  // than a flat line that would hide a scaling bug.
  const sent = 3 + ((back * 7) % 11);
  insert.run(NETWORK, day(back), sent);
  rows.push({ day: day(back), sent });
}

// READ IT BACK, because a write that reports success without checking is the defect this repo
// keeps finding. The numbers below are what the app will serve, not what we meant to write.
const after = db
  .prepare("SELECT COUNT(*) AS n, MIN(day) AS lo, MAX(day) AS hi, SUM(sent) AS total FROM drip_days WHERE network = ?")
  .get(NETWORK);
db.close();

if (after.n !== DAYS || after.lo !== day(DAYS - 1) || after.hi !== day(0)) {
  console.error(`seed-drips: read-back disagrees - ${after.n} row(s), ${after.lo} to ${after.hi}, wanted ${DAYS} from ${day(DAYS - 1)} to ${day(0)}`);
  process.exit(1);
}
console.log(`seed-drips: planted ${after.n} day(s), ${after.lo} to ${after.hi}, ${after.total} drips total`);
console.log(`seed-drips: countingSince will read ${after.lo}, the first day of the window, so every plotted day is counted`);
