/**
 * D1 proxy Worker for the Zcash faucet.
 *
 * The faucet app (on Render) can't bind D1 directly - only Workers can - so this
 * tiny Worker sits in front of D1 and runs parameterised SQL the app sends over
 * HTTPS, gated by a shared bearer secret. Cloudflare's recommended pattern for
 * reaching D1 from outside a Worker.
 *
 * It executes arbitrary SQL *by design*: the only caller is the faucet app,
 * which holds the secret and only ever sends its own parameterised statements.
 * Keep PROXY_SECRET secret; rotate it if it ever leaks.
 */
export interface Env {
  DB: D1Database;
  PROXY_SECRET: string;
}

interface QueryBody {
  sql?: unknown;
  params?: unknown;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Constant-time string compare so the secret check doesn't leak length/prefix. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!env.PROXY_SECRET || !safeEqual(token, env.PROXY_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }

    let body: QueryBody;
    try {
      body = (await req.json()) as QueryBody;
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    if (typeof body.sql !== "string") return json({ error: "sql (string) required" }, 400);
    const params = Array.isArray(body.params) ? (body.params as (string | number)[]) : [];

    try {
      const stmt = env.DB.prepare(body.sql).bind(...params);
      const res = await stmt.all();
      return json({ results: res.results, meta: res.meta });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
};
