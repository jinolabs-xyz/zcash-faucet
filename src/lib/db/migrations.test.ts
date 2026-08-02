/**
 * The ledger migration mechanism (#213).
 *
 * THE ACCEPTANCE CRITERION IS THE FIRST TEST, and it is deliberately not "a fresh
 * database has the column". A fresh database gets it from SCHEMA, so that check
 * passes with no migration mechanism at all: it is precisely the assertion that
 * would have stayed green while the live box broke. What matters is that a database
 * created on the OLD schema gains the column when the app opens it.
 *
 * Every test builds its own database in its own directory, because the driver opens
 * `$cwd/data/faucet.db` and a shared one would let these interfere (rule 14).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3");

process.env.RATE_LIMIT_SALT = "migrations-test-salt";
const { SqliteDriver } = await import("./driver.ts");
const { MIGRATIONS, SCHEMA, INDEXES } = await import("./sql.ts");

// Resolved from this file, not from cwd: every test here chdirs into a scratch dir.
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/** The claims table as it stood before subnet_hash, which is what the live box has. */
const OLD_CLAIMS = `
CREATE TABLE claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  address_hash  TEXT    NOT NULL,
  ip_hash       TEXT    NOT NULL,
  amount_zat    INTEGER NOT NULL,
  txid          TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL
);`;

/** A scratch cwd with a data/ dir, so each test gets its own ledger. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "faucet-migrations-"));
  process.chdir(dir);
  mkdirSync("data", { recursive: true });
  return dir;
}

function columns(dbPath = "data/faucet.db"): string[] {
  const db = new Database(dbPath, { readonly: true });
  const cols = (db.prepare("PRAGMA table_info(claims)").all() as { name: string }[]).map((c) => c.name);
  db.close();
  return cols;
}

/** Index name → the columns it covers, in order. Autoindexes excluded: they are
 *  sqlite's own and say nothing about what we declared. */
function indexes(dbPath = "data/faucet.db"): Record<string, string[]> {
  const db = new Database(dbPath, { readonly: true });
  const out: Record<string, string[]> = {};
  for (const idx of db.prepare("PRAGMA index_list(claims)").all() as { name: string; origin: string }[]) {
    if (idx.origin !== "c") continue;
    out[idx.name] = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as { name: string }[]).map((c) => c.name);
  }
  db.close();
  return out;
}

test("an OLD-schema database GAINS the column when the app opens it", () => {
  // The whole point of #213. Before the mechanism, CREATE TABLE IF NOT EXISTS was a
  // no-op here and the column never arrived, so the next INSERT naming it 500'd
  // every claim.
  scratch();
  const old = new Database("data/faucet.db");
  old.exec(OLD_CLAIMS);
  old.close();
  assert.ok(!columns().includes("subnet_hash"), "precondition: the old schema lacks it");

  new SqliteDriver();

  assert.ok(columns().includes("subnet_hash"), "the migration did not reach an existing database");
});

test("existing rows survive the migration untouched", () => {
  // A migration that loses the cooldown history would hand everyone a fresh drip.
  scratch();
  const old = new Database("data/faucet.db");
  old.exec(OLD_CLAIMS);
  old.prepare(
    "INSERT INTO claims (address_hash, ip_hash, amount_zat, status, created_at) VALUES (?,?,?,?,?)",
  ).run("addr-1", "ip-1", 10_000_000, "sent", 1_700_000_000);
  old.close();

  new SqliteDriver();

  const db = new Database("data/faucet.db", { readonly: true });
  const row = db.prepare("SELECT address_hash, subnet_hash, status FROM claims").get() as {
    address_hash: string; subnet_hash: string | null; status: string;
  };
  db.close();
  assert.equal(row.address_hash, "addr-1");
  assert.equal(row.status, "sent");
  assert.equal(row.subnet_hash, null, "a migration cannot invent a value for a historic row");
});

test("running twice is a no-op, so a restart is not a second migration", () => {
  // Rule 14's twin. A migration that can only run once has not been shown to be
  // idempotent, and every boot runs this.
  scratch();
  const old = new Database("data/faucet.db");
  old.exec(OLD_CLAIMS);
  old.close();

  new SqliteDriver();
  const afterFirst = columns();
  new SqliteDriver(); // a restart
  new SqliteDriver(); // and another
  assert.deepEqual(columns(), afterFirst, "a repeat open changed the table");
});

test("a FRESH database and a MIGRATED one converge exactly", () => {
  // Otherwise a box's behaviour depends on when its database was created, which is
  // the worst kind of difference to debug because nothing about it is visible.
  const freshDir = scratch();
  new SqliteDriver();
  const fresh = columns();

  scratch();
  const old = new Database("data/faucet.db");
  old.exec(OLD_CLAIMS);
  old.close();
  new SqliteDriver();
  const migrated = columns();

  assert.deepEqual(migrated, fresh, `migrated ${migrated} does not match fresh ${fresh}`);
  assert.ok(freshDir.length > 0);
});

test("every migration's column is also in SCHEMA, or the two paths cannot converge", () => {
  // Catches the likely mistake directly: adding a migration and forgetting SCHEMA
  // leaves fresh databases without the column, which is the same bug mirrored.
  for (const m of MIGRATIONS) {
    assert.match(
      SCHEMA,
      new RegExp(`\\b${m.presentWhen.column}\\b`),
      `${m.id} adds ${m.presentWhen.column} but SCHEMA never declares it`,
    );
  }
});

test("AN INDEX OVER A MIGRATED COLUMN REACHES AN EXISTING DATABASE", () => {
  // The bug this ordering exists to prevent, and it is not hypothetical: with the
  // indexes still at the bottom of SCHEMA, the driver ran them BEFORE migrate(), so
  // `idx_claims_addr_net ON claims(address_hash, network, created_at)` would have
  // thrown "no such column: network" at boot on every existing box while every fresh
  // one came up clean. Constructing the driver at all is the assertion.
  scratch();
  const old = new Database("data/faucet.db");
  old.exec(OLD_CLAIMS);
  old.close();

  new SqliteDriver();

  const idx = indexes();
  assert.deepEqual(
    idx.idx_claims_addr_net,
    ["address_hash", "network", "created_at"],
    "the cooldown index did not reach a migrated database, or covers the wrong columns",
  );
  assert.equal(idx.idx_claims_addrhash, undefined, "the superseded two-column index should be dropped");
});

test("indexes converge between a fresh database and a migrated one, like the columns do", () => {
  // Columns converging while indexes do not would leave two boxes with identical
  // schemas and different query plans, which is the same class of invisible
  // difference the column convergence test exists to stop.
  scratch();
  new SqliteDriver();
  const fresh = indexes();

  scratch();
  const old = new Database("data/faucet.db");
  old.exec(OLD_CLAIMS);
  old.close();
  new SqliteDriver();

  assert.deepEqual(indexes(), fresh);
});

test("the cooldown index leads with the two EQUALITY columns, not the range one", () => {
  // (address_hash, network) are equalities and created_at is a range. Putting the
  // range first would leave sqlite unable to use anything past it, so this pins the
  // ORDER rather than just the membership: a set-equal assertion would pass on the
  // arrangement that makes the index useless.
  scratch();
  new SqliteDriver();
  assert.deepEqual(indexes().idx_claims_addr_net, ["address_hash", "network", "created_at"]);
});

test("THE D1 SCHEMA FILE ACTUALLY MIRRORS SCHEMA", () => {
  // worker/schema.sql says it mirrors sql.ts and had fallen three changes behind
  // before anyone checked: no subnet_hash, no used_challenges, no drip_days. D1 has
  // no migration runner, so that file is the whole story there, and a claims table
  // without subnet_hash cannot satisfy RESERVE_SQL at all. Every claim on a D1
  // deployment would have failed, and the only thing asserting otherwise was a
  // comment at the top of the file.
  //
  // Checked by CONTENT rather than by diffing text: the two files are legitimately
  // different documents (D1 needs the migrated columns inline, sqlite gets them from
  // the runner), so the property is that every column and table the code needs is
  // declared, not that the bytes match.
  const d1 = readFileSync(join(REPO, "worker/schema.sql"), "utf8");

  for (const table of ["claims", "used_challenges", "drip_days"]) {
    assert.match(d1, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `D1 is missing the ${table} table`);
  }
  // Every column the sqlite side ends up with, whether it got there via SCHEMA or via
  // a migration. D1 has no runner, so both kinds have to be inline.
  scratch();
  new SqliteDriver();
  for (const col of columns()) {
    assert.match(d1, new RegExp(`^\\s*${col}\\s`, "m"), `D1's claims table is missing ${col}`);
  }
  for (const m of MIGRATIONS) {
    assert.match(d1, new RegExp(`\\b${m.presentWhen.column}\\b`), `${m.id} never reached the D1 schema`);
  }
  // And the indexes, which are a separate statement block on our side now.
  for (const name of INDEXES.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)) {
    assert.match(d1, new RegExp(`\\b${name[1]}\\b`), `D1 is missing index ${name[1]}`);
  }
});

test("the mechanism is exercised by at least one real migration", () => {
  // A migration runner with an empty list is untested infrastructure that will be
  // trusted the first time it matters. If this ever fails because the list was
  // emptied, the rest of this file has stopped proving anything.
  assert.ok(MIGRATIONS.length >= 1, "no migrations, so nothing above exercised the runner");
});
