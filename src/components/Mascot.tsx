"use client";

import { Mascot as PageMascot } from "page-mascot";

/**
 * THE MASCOT BOUNDARY. One place in the app that knows which mascot we ship and where its
 * sheets live, so the page says `<Mascot />` and nothing else has an opinion.
 *
 * It exists because the mascot has already been replaced once: the hand-cut layered fox with
 * its blindfold SVG and pointer spring loop was built, reviewed and retired inside a day when
 * the owner picked koboyo's fox-riso through `page-mascot` instead (MASCOT.md, owner ruling
 * 2026-09-15T19:40Z). The next swap should be this file and not the hero.
 *
 * WHAT IS IN THE DEPENDENCY, checked rather than assumed before putting it on a page that
 * moves money: page-mascot 0.1.0, MIT, 32 KB installed, seven files. Zero runtime
 * dependencies, one peer (react >= 18). No `preinstall`/`install`/`postinstall`/`prepare`
 * hooks. The component is 168 lines and contains no `fetch`, `XMLHttpRequest`, `WebSocket`,
 * `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `sendBeacon`, `eval`,
 * `new Function` or dynamic `import()` - so it draws and it does not phone home. The five npm
 * audit advisories on this tree are pre-existing (bitgo, elliptic, secp256k1) and none of
 * them is this.
 *
 * THE SHEETS WE SERVE ARE NO LONGER THE FROZEN ONES, and that sentence used to say they were.
 * The bare sheets in `public/mascots/` are still byte-identical to snapshot S2-S5-20260915T1943Z
 * and are kept; what the page loads is the blindfolded pair derived from them.
 *
 * NO SHAS HERE, ON PURPOSE. The first version of this comment pinned them, with a line saying
 * they "move whenever the art does" - and the art moved twice the same day and the comment did
 * not, because a comment is a pin that cannot go red. The enforced pin is SERVED_SHEETS in
 * scripts/mascot-check.mjs, whose row fails on a mismatch. One source of truth, and it is the one
 * that can fail.
 */

/** The 3x3 sheets, served from public/. Paths live here so only this file knows them. */
const DIRECTIONS = "/mascots/fox-riso-directions-blindfold.webp";
const REACTIONS = "/mascots/fox-riso-reactions-blindfold.webp";

/**
 * The hero's intrinsic size. The component writes it inline, and `.mascot-riso` in the hero
 * CSS overrides width/height so the fox follows its column instead of this number - that
 * `!important` is the spec's, and it is why this value is a starting point rather than a
 * layout decision.
 */
const SIZE = 300;

export function Mascot({ className = "mascot-riso", label = "faucet fox" }: { className?: string; label?: string }) {
  return (
    <PageMascot
      className={className}
      directions={DIRECTIONS}
      reactions={REACTIONS}
      size={SIZE}
      label={label}
    />
  );
}
