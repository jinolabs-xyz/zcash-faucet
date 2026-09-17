import { MARK_RING, MARK_VIEWBOX, MARK_Z } from "./zcashMark";

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
 * does not hold itself out as official or endorsed. This faucet is neither, and /terms
 * says so in as many words: "It is an independent community project. It is not an official
 * Zcash service and is not affiliated with, sponsored by, or endorsed by the Electric Coin
 * Company", with a "Trademarks and licence" section naming ECC and linking the policy.
 *
 * It used to say the FOOTER carried this beside a link to z.cash. Both halves of that are
 * gone as of the redesign: the footer line moved to /terms and the masthead is one link
 * home. The condition is met by the statement, not by the hyperlink (CTO, 2026-09-15).
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
      data-testid="brand-mark"
      className="brand-mark"
      width={`${CAP_MATCHED_EM}em`}
      height={`${CAP_MATCHED_EM}em`}
      viewBox={MARK_VIEWBOX}
      style={{ flex: "none" }}
    >
      <g fill="currentColor">
        <path d={MARK_RING} />
        <path d={MARK_Z} />
      </g>
    </svg>
  );
}
