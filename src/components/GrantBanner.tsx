"use client";
/**
 * THE GRANT BANNER. Owner ask, 2026-09-21T12:04Z: a band across the top of the hero, directly
 * below the nav, saying the Coinholder-Directed Retroactive Grants vote is open and asking for a
 * vote if the faucet has been useful. Voting is open 17 to 29 September 2026 (forum thread
 * 57056); our proposal is #7, "Self-Sovereign Zcash Testnet Faucet", and its own thread is the
 * link. Eight days, so it ships today and comes out after the 29th.
 *
 * THE REFERENCE THE OWNER SENT is the Aceternity StickyBanner (Tailwind + motion). Built with
 * ours instead, trait for trait: the CTA gradient for the band, the CTA text colour, a link that
 * underlines on hover, a dismiss X drawn inline like every icon on the site, a 300 ms slide-in on
 * the site's own easing that reduced-motion turns off, and a close that lasts until the next
 * page load - useState only, no storage, because a returning visitor should see it again for the
 * eight days it is up. THE ONE DELIBERATE DEPARTURE FROM THE REFERENCE: it is IN FLOW below the
 * nav, not sticky. The page is one screen on desktop by rule and a sticky band on a phone would
 * eat the viewport; the reference's scroll listener (and its console.log) never ships.
 *
 * The copy is under the site's rules: no em dash, no semicolon, no prose colon, no pool name.
 */
import { useState } from "react";

export const GRANT_URL = "https://forum.zcashcommunity.com/t/retroactive-grant-application-self-sovereign-zcash-testnet-faucet/57002";

export function GrantBanner() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <aside className="grant" data-testid="grant-banner" aria-label="Coinholder grant vote">
      <p>
        This faucet is up for a Coinholder-Directed Retroactive Grant, and voting is open until 29 September.{" "}
        <span className="grant-more">If it has been useful to you, your vote helps.{" "}</span>
        <a href={GRANT_URL} target="_blank" rel="noreferrer" data-testid="grant-link">Read the proposal ↗</a>
      </p>
      <button type="button" className="grant-x" aria-label="Dismiss" title="Dismiss" data-testid="grant-dismiss" onClick={() => setOpen(false)}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </svg>
      </button>
    </aside>
  );
}
