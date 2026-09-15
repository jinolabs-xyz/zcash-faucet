/**
 * The D1 driver's `all()`, and what the drip counter does when the proxy answers badly.
 *
 * NO ROWS AND NO ANSWER ARE DIFFERENT ANSWERS, and this is where that distinction lives
 * for a series. A SELECT that matched nothing comes back as `results: []`; a reply with
 * no `results` at all is malformed. Reading the second as the first would hand the page a
 * zero-filled month as fact, which is the `balance ?? 0` bug in a different shape: the
 * faucet would say "no drips in 30 days" on the strength of a broken hop.
 *
 * The driver is exercised against a stubbed fetch rather than a live proxy - the thing
 * under test is how the reply is READ, and a real D1 would be a second copy of the
 * question. The counter half goes through the injected-driver seam the module already
 * has, so the assertion is on countDrips' real code path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "faucet-d1-")));
process.env.DB_BACKEND = "sqlite"; // the injected driver below is what countDrips uses

const { D1Driver } = await import("./driver.ts");
const { countDrips } = await import("./index.ts");

/** One reply from the proxy, whatever shape the test needs. */
const withReply = async <T>(body: unknown, fn: (d: InstanceType<typeof D1Driver>) => Promise<T>): Promise<T> => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    return await fn(new D1Driver("http://proxy.invalid/", "secret"));
  } finally {
    globalThis.fetch = real;
  }
};

test("a SELECT that matched nothing is an empty series, not an error", async () => {
  const rows = await withReply({ results: [] }, (d) => d.all("SELECT day, sent FROM drip_days", []));
  assert.deepEqual(rows, []);
});

test("rows come back in the order the proxy sent them", async () => {
  const rows = await withReply({ results: [{ day: "2026-08-01", sent: 2 }, { day: "2026-08-02", sent: 5 }] }, (d) =>
    d.all<{ day: string; sent: number }>("SELECT day, sent FROM drip_days", []));
  assert.deepEqual(rows.map((r) => r.day), ["2026-08-01", "2026-08-02"]);
});

test("a reply with no results array THROWS rather than reading as no rows", async () => {
  await assert.rejects(
    () => withReply({ meta: { changes: 0 } }, (d) => d.all("SELECT day, sent FROM drip_days", [])),
    /no results array/,
  );
  // And the single-row read's answer to the same reply is undefined, which its callers
  // already turn into null. Asserted here so the pair is pinned together: neither method
  // may start calling a malformed reply an answer.
  const one = await withReply({ meta: { changes: 0 } }, (d) => d.get("SELECT 1", []));
  assert.equal(one, undefined);
});

test("a series the ledger could not answer is unknown on the counter, never thirty zeros", async () => {
  // The seam the module already exposes for exactly this. The totals succeed and only
  // the series fails, which is the case that could have shipped a plausible-looking
  // month of nothing beside a correct all-time figure.
  const g = globalThis as unknown as { __faucetDriver?: unknown };
  g.__faucetDriver = {
    run: async () => ({ changes: 0, lastInsertRowid: 0 }),
    get: async (sql: string) =>
      /COUNT\(\*\) AS n FROM drip_days/.test(sql)
        ? { n: 1 } // non-empty, so the one-time seed does not run
        : { allTime: 4242, last30d: 30, last7d: 7 },
    all: async () => {
      throw new Error("D1 proxy returned no results array");
    },
  };
  try {
    assert.equal(await countDrips(Date.parse("2026-08-02T12:00:00Z")), null, "unknown, not a zero-filled month");
  } finally {
    delete g.__faucetDriver;
  }
});
