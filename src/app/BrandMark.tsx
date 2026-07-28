/**
 * The masthead mark. Same artwork as src/app/icon.svg, one identity.
 *
 * One deliberate difference: the favicon carries its own ink ground, because a
 * browser tab strip is not our canvas and we cannot query its colour. In the page
 * we DO know the ground, so the inline copy drops the ground and the Z takes
 * currentColor instead. Same geometry, same proportions, no second identity, and
 * it works in both themes without forking the file.
 *
 * No hooks, so this renders in the client page and the two server pages alike.
 */

/**
 * Sized in em, not px, so it tracks the wordmark through its clamp() instead of
 * being right at one viewport. The Z occupies 36 of the 64 viewBox units, and
 * Archivo ExtraBold caps are about 0.72em, so 0.72 / (36/64) = 1.28em makes the
 * Z exactly cap height at any font size. That is what "optically aligned to the
 * cap height" has to mean when the text is fluid.
 */
const CAP_MATCHED_EM = 1.28;

/**
 * The Z is centred in its own viewBox, but a line of text is not centred on its
 * caps: the box carries descender space below them. Centring the two boxes
 * therefore leaves the Z sitting high, measured at 1.6px against an 18px
 * wordmark and 1.3px against 15px. Both are 0.085em, so the correction is a
 * constant in em and holds across the clamp.
 */
const CAP_NUDGE_EM = 0.085;

/** Decorative next to the visible wordmark, so aria-hidden and no accessible name. */
export function BrandMark() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="brand-mark"
      width={`${CAP_MATCHED_EM}em`}
      height={`${CAP_MATCHED_EM}em`}
      viewBox="0 0 64 64"
      style={{ flex: "none", position: "relative", top: `${CAP_NUDGE_EM}em` }}
    >
      <path d="M11,14 H53 V23 L29,41 H53 V50 H11 V41 L35,23 H11 Z" fill="currentColor" />
      <rect x="0" y="56" width="64" height="8" fill="var(--color-accent)" />
    </svg>
  );
}
