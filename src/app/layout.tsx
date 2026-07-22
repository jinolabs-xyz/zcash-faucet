import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zcash Testnet Faucet (TAZ)",
  description: "Get free Zcash testnet coins (TAZ) for development. Public lightwalletd backend.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
