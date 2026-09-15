/**
 * TIP_AGREE_BLOCKS is parsed by the repo's own env parser, not by bare Number().
 *
 * SDE-Infra found this on review and measured both spellings: Number("") is 0, which makes
 * `corroborated` false for any spread at all, and Number("abc") is NaN, where `spread <=
 * NaN` is false, so corroboration would be false permanently. Either reaches the watchdog's
 * fork rung as "the references disagree" - page, heal nothing - forever, with nothing
 * saying why. The empty spelling is live in this repo precisely because the same change
 * teaches CI and the suites to set variables to empty on purpose.
 *
 * Its own file: config reads the environment once, at module load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TIP_AGREE_BLOCKS = ""; // the spelling CI now uses for other variables
const { AGREE_BLOCKS } = await import("./externalTip.ts");
const { num } = await import("../config.ts");

test("an EMPTY setting falls back to the shipped bound rather than collapsing it to zero", () => {
  assert.equal(AGREE_BLOCKS, 20, "Number('') would be 0, and every spread above zero would read as disagreement");
});

test("and a value that is not a number refuses to boot rather than disabling the check", () => {
  // The same parser, the same variable name, the failing spelling. A NaN bound cannot be
  // asserted through the module (it would have to be re-imported after the env changed,
  // and the module cache makes that a different test than it looks), so this pins the
  // parser the module now uses, on the name it uses it with.
  process.env.TIP_AGREE_BLOCKS = "abc";
  assert.throws(() => num("TIP_AGREE_BLOCKS", 20), /must be a number/);
  process.env.TIP_AGREE_BLOCKS = "";
});
