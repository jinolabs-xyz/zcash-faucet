import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
 * slice that was supposed to remove it landed.
 *
 * THE MARKER IS A WIRING FACT, NOT A FILE. This first keyed S2 to `src/components/Mascot.tsx`
 * existing, and SDE-UI's plan to ship components before wiring them is what exposed that as
 * wrong: a component file lands in one PR and the view is wired in another, so a file-existence
 * marker goes true while the view is still the old markup - red on a tree that is correct.
 * Worse for S2 specifically, the mascot is on hold pending the owner's evaluation, so S2 may
 * land its claim card with no mascot at all and a `<Mascot` marker would never fire.
 *
 * So each slice is keyed to something in the RENDERED SECTION that is only true once that
 * view has actually been transcribed. For the claim view that is the design's claim card,
 * `id="claim"`, which is also what the S2 acceptance test drives (phase-test.mjs measures
 * `#claim`'s height), so the marker and the contract are the same fact.
 *
 * S3 to S5 add their own rows. Pick a wiring fact, not a filename, and assert BOTH directions
 * or the control can never fire.
 */

const PAGE = "src/app/page.tsx";

/** One view's `<section ...>` opening tag, so its classes can be read. */
function sectionTag(src: string, view: string): string {
  const i = src.indexOf(`data-view="${view}"`);
  assert.notEqual(i, -1, `no section for the ${view} view in ${PAGE}`);
  return src.slice(src.lastIndexOf("<section", i), src.indexOf(">", i) + 1);
}

/** The body of one view's section, which is where a wiring fact would appear. */
function sectionBody(src: string, view: string): string {
  const i = src.indexOf(`data-view="${view}"`);
  assert.notEqual(i, -1, `no section for the ${view} view in ${PAGE}`);
  const open = src.indexOf(">", i) + 1;
  const close = src.indexOf("</section>", open);
  assert.notEqual(close, -1, `the ${view} section is not closed`);
  return src.slice(open, close);
}

/** view -> the marker that is true once that view has been transcribed and wired. */
const WIRED: Record<string, { marker: RegExp; what: string }> = {
  claim: { marker: /id="claim"/, what: "the design's claim card (phase-test.mjs drives #claim)" },
  // S3/S4/S5. Each marker is the component actually RENDERED in that section, which is
  // true only once the view is wired - not the component file existing, which goes true
  // one PR earlier and would fire on a tree that is correct.
  status: { marker: /<StatusCards\b/, what: "the design's three status cards" },
  analytics: { marker: /<AnalyticsCards\b/, what: "the design's analytics cards" },
  tools: { marker: /<ToolsCards\b/, what: "the design's tools cards" },
};

test("no view keeps the transitional measure after its slice has wired the real thing", () => {
  const src = readFileSync(PAGE, "utf8");
  for (const [view, { marker, what }] of Object.entries(WIRED)) {
    const wired = marker.test(sectionBody(src, view));
    const capped = sectionTag(src, view).includes("legacy-measure");
    if (wired) {
      assert.ok(
        !capped,
        `the ${view} view is wired (${what}) but still carries legacy-measure, so the ` +
          "transcribed design is squeezed into 760px of a full-width view",
      );
    } else {
      // The control. Without it this passes for ever on a tree where the class was dropped
      // early, and would never be in a position to fire.
      assert.ok(
        capped,
        `the ${view} view is not wired yet (no ${what}) but has lost its transitional ` +
          "measure, so its untranscribed content is at full width",
      );
    }
  }
});
