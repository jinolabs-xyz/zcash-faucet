/**
 * Regenerate the mascot's served assets from their sources: `npm run mascot`.
 *
 * The PNGs in assets/mascot are the artwork of record - the re-matted layers the owner
 * approved, not the originals they were cut from - and they are committed for the same
 * reason the icon sources are: without them the served files are unreproducible blobs and
 * the next person to touch the fox has no way to redo them. They are NOT served: the app
 * serves WebP out of public/mascot, and .dockerignore keeps assets/ out of the image.
 *
 * The WebP files are committed too, because Next serves public/ by file convention and
 * nothing in the build produces them. A hash of the sources goes beside them, so a source
 * edited without re-running this is a red check rather than a stale fox on the page.
 */
import sharp from "sharp";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";

const LAYERS = ["fox", "head", "body"];
// Alpha at full quality: every one of these layers is cut out, and the sweep judges the
// silhouette's edge. Colour at 92 because the fox is flat-shaded and the difference from
// lossless is invisible at a third of the bytes - measured, not assumed, and the numbers
// are in the PR body.
const OPTS = { quality: 92, alphaQuality: 100, effort: 6 };
const lines = [];
for (const name of LAYERS) {
  const src = `assets/mascot/${name}.png`;
  const out = `public/mascot/${name}.webp`;
  await sharp(src).webp(OPTS).toFile(out);
  const sum = createHash("sha256").update(readFileSync(src)).digest("hex");
  lines.push(`${sum}  ${src}`);
  console.log(`${src} ${statSync(src).size} -> ${out} ${statSync(out).size}`);
}
// The manifest names the SOURCES, not the outputs: what it catches is artwork changed
// without a rebuild, which is the failure that would otherwise ship silently.
writeFileSync("public/mascot/SOURCES.sha256", lines.join("\n") + "\n");
console.log("wrote public/mascot/SOURCES.sha256");
