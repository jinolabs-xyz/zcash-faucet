import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/**
 * The budget is a module constant, evaluated at import, so these two failure modes
 * can only be tested in a fresh process. Both were found by SDE-App running the
 * gate rather than reading it, and both made a fail-closed module fail OPEN without
 * touching a line of its logic.
 */
function probe(env: Record<string, string>): { ok: boolean; out: string } {
  const script = `
    import { SHIELD_MAX_LAG_BLOCKS, shieldFreshness, mayShield } from "./src/lib/zcash/shieldGate.ts";
    const lag40 = shieldFreshness(4_217_941, 4_217_981);
    console.log(JSON.stringify({
      budget: SHIELD_MAX_LAG_BLOCKS,
      lag40state: lag40.state,
      lag40mayShield: mayShield(lag40),
    }));
  `;
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("an UNPARSEABLE budget refuses to boot instead of disabling the gate", () => {
  // Before the fix: Number("trlue") is NaN, `lag > NaN` is false for every lag, so
  // a 40-block lag — and a 220,000-block one — both read "safe" and mayShield
  // returned true. One typo in a .env turned the money gate into a pass-through.
  const r = probe({ FAUCET_SHIELD_MAX_LAG_BLOCKS: "trlue" });
  assert.equal(r.ok, false, "must refuse to start, not start with a NaN budget");
  assert.match(r.out, /must be a number/, "and must say which value it rejected");
  assert.doesNotMatch(r.out, /"lag40state":"safe"/, "it must never have reached a verdict at all");
});

test("a budget set past the cliff is CLAMPED, not honoured", () => {
  // A test asserting the source default stays small does not run in production. 500
  // in an env file was honoured, which made a 40-block lag safe again — the exact
  // condition that produced a born-expired transaction in #172.
  const r = probe({ FAUCET_SHIELD_MAX_LAG_BLOCKS: "500" });
  assert.equal(r.ok, true, "a too-large value is clamped rather than fatal");
  const parsed = JSON.parse(r.out.trim().split("\n").pop()!);
  assert.ok(parsed.budget <= 10, `budget ${parsed.budget} was not clamped`);
  assert.equal(parsed.lag40state, "unsafe", "a 40-block lag must still be unsafe");
  assert.equal(parsed.lag40mayShield, false);
});

test("a legitimate tightening is respected", () => {
  // Stricter is always allowed: the ceiling is a maximum, not a target.
  const r = probe({ FAUCET_SHIELD_MAX_LAG_BLOCKS: "1" });
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.out.trim().split("\n").pop()!);
  assert.equal(parsed.budget, 1);
});
