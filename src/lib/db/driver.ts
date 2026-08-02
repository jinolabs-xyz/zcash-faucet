/**
 * Async DB driver interface + two implementations.
 * The async shape is dictated by D1 (each query is an HTTPS round-trip); the
 * SQLite driver just wraps synchronous better-sqlite3 calls in resolved promises.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { INDEXES, MIGRATIONS, SCHEMA, TABLE_COLUMNS_SQL } from "./sql.ts";

/**
 * A bound SQL parameter. NULL is a value SQLite and Postgres both take, and the type
 * excluding it is what pushed `finalizeClaim` into writing "" for a missing txid: the
 * absence could not be expressed, so it was converted at the write and became
 * unrecoverable downstream.
 */
export type SqlParam = string | number | null;

export interface Row {
  [k: string]: unknown;
}
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}
export interface DbDriver {
  run(sql: string, params: SqlParam[]): Promise<RunResult>;
  get<T = Row>(sql: string, params: SqlParam[]): Promise<T | undefined>;
}

/** Local file SQLite — dev and single-box deploys. */
export class SqliteDriver implements DbDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor() {
    // Load lazily so the native module is never pulled in on D1, and through
    // createRequire so this works under plain ESM too (node --test) where a
    // bare require() does not exist.
    const req = createRequire(import.meta.url);
    const Database = req("better-sqlite3");
    const dir = join(process.cwd(), "data");
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "faucet.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    // TABLES, then MIGRATIONS, then INDEXES, and that order is forced rather than
    // stylistic. An index over a migrated column cannot be created before the ALTER
    // that adds the column, so with indexes still inside SCHEMA the first boot after
    // #326 would have thrown "no such column: network" on every existing database
    // while every fresh one came up fine. Same shape as #213: the statement that
    // defines the contract only reaching the thing that does not exist yet.
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(INDEXES);
  }

  /**
   * Bring an EXISTING database up to the current schema (#213).
   *
   * Synchronous and in the constructor, deliberately: every read and write goes
   * through this driver, so there is no ordering in which a query could beat the
   * migration. An async post-construction step would have that race.
   *
   * Skips rather than swallows. A migration whose column is already there is not
   * attempted at all, so a genuine failure still throws and takes the process down
   * at boot with the reason, which is where a broken ledger should be discovered.
   */
  private migrate() {
    for (const m of MIGRATIONS) {
      const cols = this.db.prepare(TABLE_COLUMNS_SQL(m.presentWhen.table)).all() as { name: string }[];
      if (cols.some((c) => c.name === m.presentWhen.column)) continue;
      this.db.exec(m.sql);
      console.log(`[db] applied migration ${m.id}`);
    }
  }

  async run(sql: string, params: SqlParam[]): Promise<RunResult> {
    const r = this.db.prepare(sql).run(...params);
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  }

  async get<T = Row>(sql: string, params: SqlParam[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
}

/** Cloudflare D1 via the proxy Worker (see worker/). Survives ephemeral disks. */
export class D1Driver implements DbDriver {
  // Plain fields, not constructor parameter properties: node --test runs on
  // type stripping, which erases types but cannot rewrite that sugar.
  private url: string;
  private secret: string;

  constructor(url: string, secret: string) {
    if (!url || !secret) throw new Error("DB_BACKEND=d1 requires D1_PROXY_URL and D1_PROXY_SECRET.");
    this.url = url;
    this.secret = secret;
  }

  private async query(sql: string, params: SqlParam[]) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`D1 proxy ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as { results?: Row[]; meta?: { changes?: number; last_row_id?: number } };
  }

  async run(sql: string, params: SqlParam[]): Promise<RunResult> {
    const { meta } = await this.query(sql, params);
    return { changes: meta?.changes ?? 0, lastInsertRowid: meta?.last_row_id ?? 0 };
  }

  async get<T = Row>(sql: string, params: SqlParam[]): Promise<T | undefined> {
    const { results } = await this.query(sql, params);
    return (results?.[0] as T) ?? undefined;
  }
}
