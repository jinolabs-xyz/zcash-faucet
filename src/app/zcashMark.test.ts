import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACCENT, INK, MARK_RING, MARK_Z, PAPER } from "./zcashMark.ts";

/**
 * #646: the mark and the palette are drawn in four places - BrandMark.tsx, icon.svg and the
 * three generated images - and the PNGs had already drifted to the pre-redesign Z while the
 * SVG carried the new one. These rows tie the copies this module cannot import.
 */
const svg = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");
const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

test("#646: icon.svg draws the same trademark paths as the module", () => {
  assert.ok(svg.includes(MARK_RING), "icon.svg ring path has drifted from zcashMark.ts");
  assert.ok(svg.includes(MARK_Z), "icon.svg Z path has drifted from zcashMark.ts");
});

test("#646: icon.svg is painted in the module's colours", () => {
  assert.ok(svg.includes(INK), `icon.svg ground is not ${INK}`);
  assert.ok(svg.includes(PAPER), `icon.svg mark is not ${PAPER}`);
  assert.ok(svg.includes(ACCENT), `icon.svg rule is not ${ACCENT}`);
});

/** The colours are the design's, not ours: read them back out of the stylesheet that owns them. */
test("#646: the module's colours are the ones globals.css ships", () => {
  const token = (name: string) => {
    const hits = [...css.matchAll(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,8})`, "g"))].map((m) => m[1]);
    assert.ok(hits.length > 0, `--color-${name} not found in globals.css`);
    return hits;
  };
  assert.ok(token("bg").includes(PAPER), `PAPER ${PAPER} is not a --color-bg globals.css defines`);
  assert.ok(token("bg").includes(INK), `INK ${INK} is not a --color-bg globals.css defines`);
  assert.ok(token("accent").includes(ACCENT), `ACCENT ${ACCENT} is not --color-accent`);
});
