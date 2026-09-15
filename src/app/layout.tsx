import type { Metadata, Viewport } from "next";
import "./globals.css";

const TITLE = "Zcash Testnet Faucet (TAZ)";
const DESCRIPTION =
  "Get free testnet ZEC (TAZ), sent privately. A self-mining, shielded-by-default Zcash testnet faucet.";

/**
 * Absolute base for og:image and og:url. Relative image paths in metadata need
 * this or the tags ship as bare paths, which no scraper will follow.
 *
 * Override with NEXT_PUBLIC_SITE_URL when running your own instance. The default
 * is ours because this repo is that site, but a fork that leaves it alone would
 * advertise our URL on its own social cards.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://zcashfaucet.jinolabs.xyz";

// icon.svg, icon.png, apple-icon.png and opengraph-image.png are picked up from
// this directory by file convention, so they are not listed here.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: TITLE,
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    // The card is 1200x630, the large-image ratio. Declaring "summary" instead
    // would crop it square and cut the wordmark in half.
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

/**
 * Paints the browser's own chrome (the iOS status bar, the Android toolbar) so it
 * matches the page instead of sitting dark above a light header. Static PAPER now,
 * because the approved redesign is a light design and paper is the default state.
 * The home toggle rewrites this tag live, so an ink user does not keep a light
 * toolbar (#143). The value is the design's --page.
 *
 * Deliberately NOT media-based: our theme is a manual toggle rather than
 * prefers-color-scheme, so keying it to the OS setting would be wrong for anyone
 * whose two disagree.
 */
export const viewport: Viewport = {
  themeColor: "#f0f0f0",
};

/**
 * Applies a stored theme BEFORE first paint.
 *
 * The page reads localStorage in an effect, which runs after the first paint, so with a
 * light default an ink visitor used to get a white flash on every single load. This is the
 * one thing that cannot be done in React: it has to be a blocking script in <head>.
 *
 * Wrapped in try/catch because localStorage throws rather than returning null in a private
 * window and wherever site data is blocked, and a theme preference is not worth a blank
 * page. Unknown values are ignored, so a corrupted key falls back to the paper default.
 */
const THEME_BOOT = `try{var t=localStorage.getItem("zfaucet_theme");if(t==="ink"||t==="paper")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme defaults to PAPER because that is the redesign's default state and the
    // default of the server-rendered pages. The boot script above upgrades it to a stored
    // choice before paint, and the home toggle updates it live. It exists so the ROOT is
    // theme-painted: the overscroll region is drawn from html, not from the app shell
    // (#143).
    <html lang="en" data-theme="paper">
      <head>
        {/* Before any paint, and before any stylesheet has painted a background. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
