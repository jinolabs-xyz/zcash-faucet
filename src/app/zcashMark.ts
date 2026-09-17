/**
 * The official Zcash 2018 mark, path data verbatim from github.com/zcash/logos
 * (zcash-logos-icons-2018/icons/black). One owner, because it is also drawn by
 * icon.svg and by the generated icons and share card - three hand-copies of a
 * trademark is how one of them quietly stops being the logo (#646).
 * Trademark terms and why the 2018 mark and not Heartwood: see BrandMark.tsx.
 */
export const MARK_VIEWBOX = "0 0 493.3 490.2";

/** The ring. */
export const MARK_RING =
  "m245.4 20c-124.3 0-225.4 101.1-225.4 225.4s101.1 225.4 225.4 225.4 225.4-101.1 225.4-225.4-101.1-225.4-225.4-225.4zm0 413.6c-103.8 0-188.2-84.4-188.2-188.2s84.4-188.2 188.2-188.2 188.2 84.4 188.2 188.2-84.4 188.2-188.2 188.2z";

/** The struck-through Z. */
export const MARK_Z =
  "m325.8 175.1v-34.3h-61.5v-37.8h-37.8v37.8h-61.5v45.5h95.4l-95.4 129.4v34.3h61.5v37.6h37.8v-37.6h61.5v-45.5h-95.4z";

/**
 * The redesign's own colours, spelled here because an ImageResponse renders
 * outside the document and cannot read a CSS custom property.
 * Kept honest by zcashMark.test.ts, which reads them back out of globals.css.
 */
export const INK = "#171615";
export const PAPER = "#f3f2f2";
export const ACCENT = "#ec3013";
