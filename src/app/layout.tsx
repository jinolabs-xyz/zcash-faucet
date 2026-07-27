import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zcash Testnet Faucet (TAZ)",
  description:
    "Get free testnet ZEC (TAZ), sent privately. A self-mining, shielded-by-default Zcash testnet faucet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
