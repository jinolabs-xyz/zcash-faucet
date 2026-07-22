/**
 * Async DB driver interface + two implementations.
 * The async shape is dictated by D1 (each query is an HTTPS round-trip); the
 * SQLite driver just wraps synchronous better-sqlite3 calls in resolved promises.
 */
import { SCHEMA } from "./sql";

export interface Row {
  [k: string]: unknown;
}
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}
export interface DbDriver {
  run(sql: string, params: (string | number)[]): Promise<RunResult>;
  get<T = Row>(sql: string, params: (string | number)[]): Promise<T | undefined>;
}

/** Local file SQLite — dev and single-box deploys. */
export class SqliteDriver implements DbDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor() {
    // Import lazily so the native module isn't required when running on D1.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync } = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require("node:path");
    const dir = join(process.cwd(), "data");
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "faucet.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  async run(sql: string, params: (string | number)[]): Promise<RunResult> {
    const r = this.db.prepare(sql).run(...params);
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  }

  async get<T = Row>(sql: string, params: (string | number)[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
}

/** Cloudflare D1 via the proxy Worker (see worker/). Survives ephemeral disks. */
export class D1Driver implements DbDriver {
  constructor(
    private url: string,
    private secret: string,
  ) {
    if (!url || !secret) throw new Error("DB_BACKEND=d1 requires D1_PROXY_URL and D1_PROXY_SECRET.");
  }

  private async query(sql: string, params: (string | number)[]) {
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

  async run(sql: string, params: (string | number)[]): Promise<RunResult> {
    const { meta } = await this.query(sql, params);
    return { changes: meta?.changes ?? 0, lastInsertRowid: meta?.last_row_id ?? 0 };
  }

  async get<T = Row>(sql: string, params: (string | number)[]): Promise<T | undefined> {
    const { results } = await this.query(sql, params);
    return (results?.[0] as T) ?? undefined;
  }
}
