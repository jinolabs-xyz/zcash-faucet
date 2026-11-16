// The SHIPPED escalation, with nothing overridden. Every other pow test sets
// FAUCET_POW_ESCALATE_BITS itself, so none of them would notice the default moving.
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.FAUCET_POW_ESCALATE_BITS;
delete process.env.FAUCET_POW_BITS;
const { config } = await import("./config.ts");

test("a household's third claim in an hour is base + 2 bits, not base + 4", () => {
  assert.equal(config.pow.escalateBits, 1);
  assert.equal(config.pow.baseBits + 2 * config.pow.escalateBits, 22);
});
