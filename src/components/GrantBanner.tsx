"use client";
/**
 * THE SITE NOTICE BAND, first built for the grant vote (#737, closed 29 September). Owner ask
 * 2026-10-08: testnet activated NU7 at 4,465,026 on 4 October and no Zallet release supports it
 * yet (zcash/zallet#898), so drips are paused. The band says so and points at a faucet that is
 * paying on NU7. Class names and test ids keep "grant" so ui-smoke's layout rows still bind.
 *
 * THE REFERENCE THE OWNER SENT is the Aceternity StickyBanner (Tailwind + motion). Built with
 * ours instead, trait for trait: the CTA gradient for the band, the CTA text colour, a link that
 * underlines on hover, a dismiss X drawn inline like every icon on the site, a 300 ms slide-in on
 * the site's own easing that reduced-motion turns off, and a close that lasts until the next
 * page load - useState only, no storage, because a returning visitor should see it again while
 * it is up. THE ONE DELIBERATE DEPARTURE FROM THE REFERENCE: it is IN FLOW at the top,
 * not sticky. The page is one screen on desktop by rule and a sticky band on a phone would
 * eat the viewport; the reference's scroll listener (and its console.log) never ships.
 *
 * The copy is under the site's rules: no em dash, no semicolon, no prose colon, no pool name.
 */
import { useState } from "react";

// Valar Group's testnet faucet: live on NU7 when this shipped (zecd sender, /api/status ready).
export const NOTICE_URL = "https://faucet.testnet.valargroup.dev";

export function GrantBanner() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <aside className="grant" data-testid="grant-banner" aria-label="Drips paused for the NU7 upgrade">
      <p>
        Drips are paused for the testnet NU7 upgrade.{" "}
        <span className="grant-more">Zallet, the wallet this faucet sends with, has no NU7 release yet. Need TAZ now?{" "}</span>
        <a href={NOTICE_URL} target="_blank" rel="noreferrer" data-testid="grant-link">Try Valar&apos;s faucet ↗</a>
      </p>
      <button type="button" className="grant-x" aria-label="Dismiss" title="Dismiss" data-testid="grant-dismiss" onClick={() => setOpen(false)}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </svg>
      </button>
    </aside>
  );
}
