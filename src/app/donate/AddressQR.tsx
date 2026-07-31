/**
 * A scannable QR of an address, rendered as inline SVG on the server.
 *
 * Server rendered and inline for the same reason the addresses are: /donate has to
 * work with JavaScript off, and a page whose job is handing over an address for real
 * money must not depend on a script running. It also means no request leaves the
 * browser to draw it, so nobody learns who looked at our donation page. A hosted QR
 * service would have been three lines and would have leaked exactly that.
 *
 * ALWAYS BLACK ON WHITE, in both themes, and that is deliberate rather than an
 * oversight. Scanners expect dark modules on a light field; inverted codes work on
 * some phones and fail on others, and a QR that fails to scan is worse than one that
 * clashes with the palette. The white plate is drawn explicitly instead of inherited,
 * so a future theme change cannot quietly break scanning.
 */
import qrcode from "qrcode-generator";

/** Modules of clear space the spec requires around the code. Scanners need it. */
const QUIET_ZONE = 4;

/**
 * SIZE IS A SCANNING REQUIREMENT, NOT A STYLE CHOICE, and getting it wrong is why
 * the first version of this did nothing when scanned. A phone camera pointed at a
 * screen needs roughly 4 device pixels per module to resolve one; the first version
 * drew 61 modules into 132px, about 2.2px each, which a software decoder reads
 * happily and a camera does not. 240px over 57 modules is 4.2px each.
 */
const DEFAULT_SIZE = 240;

export function AddressQR({ address, size = DEFAULT_SIZE, label }: { address: string; size?: number; label: string }) {
  // ZIP-321 payment URI, not the bare address. A wallet that scans `zcash:u1...`
  // recognises a payment request and opens its send screen on it; a bare address is
  // just a string it may or may not choose to act on, which is what "nothing
  // happens" looks like from the user's side.
  //
  // Measured, not assumed: at error correction L the URI encodes to 49 modules, the
  // SAME as the bare address, so the scheme prefix costs nothing in density here.
  const payload = `zcash:${address}`;

  // L rather than M, deliberately. Error correction buys resilience against a
  // damaged code, which is a printing concern; this one is drawn on a screen and
  // cannot smudge. Spending that budget on FEWER, BIGGER modules is what a phone
  // camera actually needs: 49 modules instead of 57.
  const qr = qrcode(0, "L");
  qr.addData(payload);
  qr.make();

  const count = qr.getModuleCount();
  const dim = count + QUIET_ZONE * 2;

  // One path for every dark module beats one <rect> each: same pixels, a fraction of
  // the markup, and it keeps the served HTML small on a page that already carries two
  // long addresses.
  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      style={{ display: "block", flex: "none" }}
    >
      <rect width={dim} height={dim} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
