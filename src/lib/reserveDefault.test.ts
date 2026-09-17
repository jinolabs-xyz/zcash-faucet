/**
 * The reserve levels an operator who sets NOTHING gets.
 *
 * config.ts reads env once at import, so every other reserve test sets its own levels and
 * none of them touch the shipped value. That is the shape where a default drifts unnoticed:
 * prod ran 1,000/500 set by hand while the repo said 15/5 and nothing compared them.
 * Child process per case, same reason as challengeDefault.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/** Boot config.ts under `env` and report the reserve levels in TAZ, or THREW:<msg>. */
function reserveUnder(env: Record<string, string> = {}): string {
  const script =
    'import("./src/lib/config.ts")' +
    '.then((m) => { const z = 100000000n;' +
    ' console.log(`${m.config.reserve.targetZatoshi / z}/${m.config.reserve.lowZatoshi / z}`); })' +
    '.catch((e) => console.log("THREW:" + e.message));';
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH ?? "", FAUCET_SENDER: "zallet", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return child.stdout.trim();
}

test("an operator who sets NOTHING gets the levels this faucet intends to hold", () => {
  // Owner's decision 2026-09-17: 10,000 target, 5,000 floor, maintained.
  assert.equal(reserveUnder(), "10000/5000");
});

test("and the knob still overrides, so the default is a default and not a constant", () => {
  assert.equal(reserveUnder({ FAUCET_RESERVE_TARGET_TAZ: "30", FAUCET_RESERVE_LOW_TAZ: "10" }), "30/10");
});

test("the boot guard still refuses a floor at or above the target", () => {
  assert.match(reserveUnder({ FAUCET_RESERVE_TARGET_TAZ: "100", FAUCET_RESERVE_LOW_TAZ: "100" }), /^THREW:/);
});
