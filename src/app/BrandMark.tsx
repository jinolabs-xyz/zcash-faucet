/**
 * The official Zcash icon, path data taken verbatim from github.com/zcash/logos
 * (zcash-logos-icons-2018/icons/black). Not a redraw: reproducing a trademark by
 * eye gets you something that is almost the logo, which is worse than not using it.
 *
 * WHY THE 2018 MARK AND NOT HEARTWOOD. The newer Heartwood icon is the better
 * artwork and it is unusable here. It carries fine concentric detail that collapses
 * into a speckled blob at the ~17px this masthead renders, which defeats the whole
 * reason for using a known logo. The 2018 mark is two shapes, a ring and a struck
 * through Z, and it survives being small. Recognisable at the size we actually ship
 * beats faithful to the newest asset.
 *
 * TRADEMARK. The mark belongs to the Electric Coin Company and third-party use is
 * governed by the Zcash Foundation's trademark policy. That policy allows a
 * community project to display it to show it works with Zcash, provided the project
 * does not hold itself out as official or endorsed. This faucet is neither, and the
 * footer says so beside a link to z.cash.
 *
 * `currentColor` rather than the upstream #231f20, so one file serves both themes.
 * Geometry is untouched.
 *
 * No hooks, so it renders in the client page and the two server pages alike.
 */

/**
 * Sized in em so it tracks the wordmark through its clamp() rather than being right
 * at exactly one viewport. The ring runs nearly edge to edge in its viewBox, unlike
 * the in-house Z this replaced which sat inset, so it needs a smaller multiplier to
 * land on the same optical weight beside the text.
 */
const CAP_MATCHED_EM = 1.02;

/** Decorative beside the visible wordmark, so aria-hidden and no accessible name. */
export function BrandMark() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="brand-mark"
      width={`${CAP_MATCHED_EM}em`}
      height={`${CAP_MATCHED_EM}em`}
      viewBox="0 0 493.3 490.2"
      style={{ flex: "none" }}
    >
      <g fill="currentColor">
        <path d="m245.4 20c-124.3 0-225.4 101.1-225.4 225.4s101.1 225.4 225.4 225.4 225.4-101.1 225.4-225.4-101.1-225.4-225.4-225.4zm0 413.6c-103.8 0-188.2-84.4-188.2-188.2s84.4-188.2 188.2-188.2 188.2 84.4 188.2 188.2-84.4 188.2-188.2 188.2z" />
        <path d="m325.8 175.1v-34.3h-61.5v-37.8h-37.8v37.8h-61.5v45.5h95.4l-95.4 129.4v34.3h61.5v37.6h37.8v-37.6h61.5v-45.5h-95.4z" />
      </g>
    </svg>
  );
}
