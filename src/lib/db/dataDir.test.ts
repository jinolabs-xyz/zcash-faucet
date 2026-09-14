/**
 * FAUCET_DATA_DIR moves the ledger (risk register II, R-40). The integration suite
 * gives each run its own directory so no run reads another's claims; a driver that
 * ignored the variable kept every other test green while the ledger went back to
 * cwd/data, which is why this is pinned on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "faucet-datadir-cwd-"));
const elsewhere = mkdtempSync(join(tmpdir(), "faucet-datadir-"));
process.chdir(cwd);
process.env.DB_BACKEND = "sqlite";
process.env.RATE_LIMIT_SALT = "datadir-salt";
process.env.FAUCET_DATA_DIR = elsewhere;

const { reserveClaim } = await import("./index.ts");

test("with FAUCET_DATA_DIR set, the ledger is created there and not under cwd/data", async () => {
  const r = await reserveClaim({ address: "utest1datadir", ipHash: null, subnetHash: null, amountZat: 1n, now: 1_800_000_000, cooldownSeconds: 60, dailyCapZat: 100n, subnetDailyMax: 10, ipDailyMax: 1 });
  assert.equal(r.ok, true);
  assert.equal(existsSync(join(elsewhere, "faucet.db")), true, "the ledger went where the variable pointed");
  assert.equal(existsSync(join(cwd, "data", "faucet.db")), false, "and nothing was written under cwd/data");
});
