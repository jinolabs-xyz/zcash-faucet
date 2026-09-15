import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

/**
 * THE TRANSITIONAL MEASURE MUST NOT OUTLIVE THE SLICE THAT NEEDED IT.
 *
 * `.view.legacy-measure` caps a view's content at the 760px the pre-redesign markup was
 * written for. The redesign's views are full width because the cards they hold are, so a
 * class left behind after a view is transcribed silently squeezes the new design into two
 * thirds of the page - and nothing goes red, because a narrow layout is not an error.
 *
 * ui-smoke holds the other direction (the class removed early, content back to full width,
 * measured). This holds the direction a browser cannot see: the class still there after the
 * slice that was supposed to remove it landed. Each slice is keyed to a REPO FACT that only
 * becomes true when that slice lands - SDE-Infra's repo-fact-plus-page-fact shape, the one
 * the CTO approved for I1.
 *
 * S3 to S5 add their own marker here as they are specified. An unkeyed slice is worse than
 * a missing test, so do not guess a marker before the slice has one.
 */

const PAGE = "src/app/page.tsx";

/** The `<section>` opening tag for one view, so the class can be read off it. */
function sectionTag(view: string): string {
  const src = readFileSync(PAGE, "utf8");
  const i = src.indexOf(`data-view="${view}"`);
  assert.notEqual(i, -1, `no section for the ${view} view in ${PAGE}`);
  const start = src.lastIndexOf("<section", i);
  return src.slice(start, src.indexOf(">", i) + 1);
}

test("every view still carrying the transitional measure is one that has not been transcribed", () => {
  // S2 lands the claim view, and the owner's ruling names its component path, so that file
  // existing IS the slice having landed. Nothing else about S2 is as unambiguous.
  const s2Landed = existsSync("src/components/Mascot.tsx");
  const claim = sectionTag("claim");
  if (s2Landed) {
    assert.ok(
      !claim.includes("legacy-measure"),
      "S2 has landed (src/components/Mascot.tsx exists) but the claim view still caps its " +
        "content at 760px, so the transcribed hero is squeezed into two thirds of the page",
    );
  } else {
    // The control: while S2 has NOT landed the class must still be there, or the content it
    // was protecting is already at full width and the assertion above would never fire.
    assert.ok(
      claim.includes("legacy-measure"),
      "the claim view is not transcribed yet (no src/components/Mascot.tsx) but has lost " +
        "its transitional measure, so its content is at full width",
    );
  }
});
