import type { Metadata } from "next";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
