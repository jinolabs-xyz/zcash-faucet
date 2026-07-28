// Regenerate the raster icons from their SVG sources: `npm run icons`.
//
// The PNGs are committed because Next serves them straight from src/app by file
// convention and nothing in the build produces them. Without this script they
// would be unreproducible blobs, and the next person to touch the mark would
// have no way to redo them at the right sizes.
//
// Sources: src/app/icon.svg (the mark) and docs/og-card.svg (the social card).
import sharp from "sharp";
import { statSync } from "node:fs";

const MARK = "src/app/icon.svg";
const CARD = "docs/og-card.svg";

const outputs = [
  // icon.svg is the primary favicon. This is the fallback for browsers without
  // SVG favicon support, which means Safari before 16.4. Named icon1.png rather
  // than icon.png on purpose: Next's file convention serves only ONE file per
  // base name, so icon.png would SILENTLY REPLACE icon.svg instead of joining
  // it. The numbered suffix is how you get both link tags.
  { src: MARK, out: "src/app/icon1.png", size: 32, density: 900 },
  { src: MARK, out: "src/app/apple-icon.png", size: 180, density: 900 },
  { src: CARD, out: "src/app/opengraph-image.png", width: 1200, height: 630, density: 300 },
];

for (const o of outputs) {
  await sharp(o.src, { density: o.density })
    .resize(o.width ?? o.size, o.height ?? o.size)
    .png({ compressionLevel: 9 })
    .toFile(o.out);
  const { width, height } = await sharp(o.out).metadata();
  console.log(`${o.out}  ${width}x${height}  ${(statSync(o.out).size / 1024).toFixed(1)}kB`);
}
