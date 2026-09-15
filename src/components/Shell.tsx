/**
 * The shell every page of the redesign sits inside: the stage, the masthead and the pinned
 * footer, from the approved snapshot (redesign-frozen/S2-S5-20260915T2224Z).
 *
 * WHY THIS EXISTS AS A COMPONENT AT ALL. S1 landed the chrome inline in `page.tsx`, which
 * was right for one page. `/terms`, `/donate` and `/fund` use the same chrome - the
 * snapshot's subpage header is byte-identical to the index's apart from the nav - and a
 * second copy of a header is a header that drifts. One definition, two navs.
 *
 * WHY IT IS A CLIENT COMPONENT WRAPPING SERVER-RENDERED CHILDREN. The three pages are
 * server-rendered with `force-dynamic` ON PURPOSE: `terms/page.tsx` says it in its own
 * header, a page whose job is to state obligations must not depend on a script running.
 * The masthead is interactive (a theme toggle, a live badge, a sparkline), so it has to be
 * a client island. Next lets a client component take server-rendered `children`, so the
 * obligations stay server-rendered and readable with JavaScript off while only the
 * furniture around them hydrates. Approved by the CTO, 21:13Z.
 */
"use client";

/*
 * THE SHELL OWNS ITS OWN STYLESHEETS, in the order the cascade needs them: tokens first
 * because everything else reads them, then the shell, then the hero and the subpages.
 * They were imported from `page.tsx` while the index was the only page that had a
 * masthead; the three subpages need the same sheets, and importing them in four places is
 * four chances for the order to differ. One importer, one order.
 *
 * ORDER IS LOAD-BEARING HERE and not merely tidy: `globals.css` (imported by the layout)
 * styles several of the same selectors, and three of tonight's defects were properties it
 * sets that a transcribed rule never names (LESSONS L20). These sheets must land after it.
 */
import "@/app/redesign-tokens.css";
import "@/app/redesign-shell.css";
import "@/app/redesign-hero.css";
import "@/app/redesign-views.css";
import "@/app/redesign-subpages.css";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/app/BrandMark";
import { Sparkline, type DripDay } from "@/app/Sparkline";

export type Theme = "paper" | "ink";

/** What the masthead reads off a status. Narrow on purpose: the shell is not a view. */
export interface ShellStatus {
  drips?: { last7d: number; allTime: number; byDay?: DripDay[] } | null;
  maintenanceAddress?: string;
}

/** The badge: one word and the colour that carries it. */
export interface ShellBadge {
  word: string;
  dot: { fill: string; ring: string };
}

/**
 * The nav is the ONLY structural difference between the index's masthead and a subpage's,
 * and the snapshot makes the distinction for a reason. On the index the views are client
 * state on one page, so buttons: an anchor would promise a navigation that does not
 * happen. On a subpage there is nothing to switch, so they are real links home.
 */
export type ShellNav =
  | { kind: "views"; view: string; onView: (v: string) => void; views: readonly string[] }
  | { kind: "links" };

const LABEL: Record<string, string> = { claim: "Claim", status: "Status", analytics: "Analytics", tools: "Tools" };
const HREF: Record<string, string> = { claim: "/", status: "/#status", analytics: "/#analytics", tools: "/#tools" };
const NAV_ORDER = ["claim", "status", "analytics", "tools"] as const;

/** Thousands separators, matching the rest of the page. */
const num = (n: number | null | undefined) => (n == null ? "–" : n.toLocaleString("en-US"));

/**
 * Theme, owned here because the masthead is the only thing that can change it.
 *
 * THE KEY IS `zfaucet_theme` AND THAT IS NOT A DETAIL. The preview stores it as
 * `faucet-theme`, and a port that keeps the preview's key writes somewhere nothing reads:
 * the boot script in layout.tsx finds nothing, so the page flashes the default and a
 * navigating check tests one theme twice while reporting two (LESSONS L3).
 *
 * PAPER IS THE DEFAULT, per the owner. The stored value wins when there is one.
 */
function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("paper");
  useEffect(() => {
    const stored = localStorage.getItem("zfaucet_theme");
    if (stored === "paper" || stored === "ink") setTheme(stored);
  }, []);
  useEffect(() => {
    localStorage.setItem("zfaucet_theme", theme);
    document.documentElement.dataset.theme = theme;
    // theme-color paints the browser's own chrome, which sits outside anything CSS reaches.
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "ink" ? "#171615" : "#f0f0f0");
  }, [theme]);
  return [theme, setTheme];
}

/** Sun and moon, each showing the theme you would GET rather than the one you are in. */
function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

/**
 * ONE FETCH, ON MOUNT, FOR THE SUBPAGES ONLY.
 *
 * The index already polls and passes its own status down, so this must not run there or
 * the page would fetch twice for one masthead. On /terms, /donate and /fund nothing else
 * asks, and the ruling (CTO, 21:13Z) is explicit that a JavaScript reader should get the
 * live state rather than a permanent CHECKING.
 *
 * ONE FETCH RATHER THAN A POLL, because these are documents. The index polls because its
 * claim button depends on readiness changing under the reader; a terms page does not, and
 * three pages quietly polling a status endpoint is a cost with no reader behind it.
 *
 * FAILURE IS SILENT AND LEAVES CHECKING IN PLACE. No error state, no retry: the badge's
 * job here is to say what we know, and "we asked and could not tell" is the same thing to
 * a reader as "we have not asked yet". What it must never do is assert a state.
 */
function useSubpageStatus(enabled: boolean): ShellStatus | null {
  const [status, setStatus] = useState<ShellStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch("/api/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setStatus(d as ShellStatus); })
      .catch(() => {});
    return () => { alive = false; };
  }, [enabled]);
  return status;
}

export function Shell({
  nav,
  badge,
  status,
  onStripClick,
  children,
}: {
  nav: ShellNav;
  badge: ShellBadge;
  status: ShellStatus | null;
  /** The index scrolls to its analytics view; a subpage navigates there. */
  onStripClick?: () => void;
  children: ReactNode;
}) {
  const [theme, setTheme] = useTheme();
  const views = nav.kind === "views" ? nav.views : NAV_ORDER;
  // The index passes its own status; a subpage asks once, for the strip's COUNTS ONLY.
  //
  // THE BADGE IS NOT DERIVED HERE, AND I TRIED IT FIRST. The ruling (CTO, 21:13Z) wanted a
  // JavaScript reader to get the live state rather than a permanent CHECKING, so I wrote a
  // three-fact derivation - node ready, backend reachable, box ok - and rendered it. On the
  // same stack, at the same moment, the subpages read NOT READY while the index read LIVE.
  // The index's word comes from a phase machine with a claim button behind it; three facts
  // is a FOURTH opinion about readiness, and a page that contradicts the page one click
  // away is worse than one that says it has not looked.
  //
  // So the badge stays CHECKING on subpages until there is ONE derivation to share, which
  // is the same precondition as the server-rendered version: something that owns "what word
  // describes the faucet right now" and can be asked by more than one page. Counts are
  // different and are fetched: a drip total is a fact we were handed, not a verdict we made.
  const fetched = useSubpageStatus(nav.kind === "links");
  const shown = status ?? fetched;
  const shownBadge = badge;

  return (
    <div className={"app " + (theme === "ink" ? "ink" : "")}>
      <div className="stage">
        <div className="comp">
          <header className="hdr">
            <div className="brand">
              <Link className="home" href="/" aria-label="Zcash Testnet Faucet, home">
                <BrandMark />
                <span className="name">Zcash Testnet Faucet</span>
              </Link>
              <span className="badge" data-state={shownBadge.word} data-testid="status-badge">
                <span className="ring">
                  <span
                    data-testid="status-dot"
                    className="dot"
                    aria-hidden="true"
                    // Inline, and that is load-bearing: the reduced-motion rule is a global
                    // `* { animation: none !important }` and only !important beats an inline
                    // declaration. A class here would keep animating for people who asked it
                    // not to.
                    style={{ background: shownBadge.dot.fill, boxShadow: `0 0 0 2px ${shownBadge.dot.ring}`, animation: "pulse 2.6s ease-in-out infinite" }}
                  />
                </span>
                <span className="txt" data-testid="status-word">{shownBadge.word}</span>
              </span>
            </div>

            <nav className="seg" aria-label="Sections">
              {views.map((v) =>
                nav.kind === "views" ? (
                  <button
                    key={v}
                    type="button"
                    data-view={v}
                    data-testid={`nav-${v}`}
                    onClick={() => nav.onView(v)}
                    {...(nav.view === v ? { "aria-current": "page" as const } : {})}
                  >
                    {LABEL[v] ?? v}
                  </button>
                ) : (
                  // Real anchors on a subpage: there is no view to switch to from here, so a
                  // button would be a control that does nothing until JavaScript arrives.
                  // These work with scripting off, which is the whole point of these pages.
                  <a key={v} href={HREF[v] ?? "/"} data-view={v} data-testid={`nav-${v}`}>
                    {LABEL[v] ?? v}
                  </a>
                ),
              )}
            </nav>

            <div className="hdr-right">
              <button
                className="strip"
                type="button"
                data-testid="drips-strip"
                onClick={onStripClick}
                aria-label="Open usage analytics"
              >
                <Sparkline
                  byDay={shown?.drips?.byDay ?? []}
                  last7d={shown?.drips?.last7d ?? null}
                  allTime={shown?.drips?.allTime ?? null}
                  theme={theme}
                />
                <span className="kv week">
                  <b className="num" data-testid="drips-7d">{shown?.drips ? num(shown.drips.last7d) : "–"}</b>
                  <span>this week</span>
                </span>
                <span className="kv all">
                  <b className="num" data-testid="drips-all">{shown?.drips ? num(shown.drips.allTime) : "–"}</b>
                  <span>all time</span>
                </span>
              </button>
              {/* `theme-toggle` stays beside the design's `iconbtn`: the class is what the
                  smoke's 1.4.11 contrast guard finds, and losing it would retire a live
                  accessibility check by accident rather than on purpose. */}
              <button
                type="button"
                data-testid="theme-toggle"
                className="iconbtn theme-toggle"
                onClick={() => setTheme(theme === "ink" ? "paper" : "ink")}
                aria-pressed={theme === "ink"}
                aria-label={theme === "ink" ? "Switch to light theme" : "Switch to dark theme"}
                title={theme === "ink" ? "Light theme" : "Dark theme"}
              >
                {theme === "ink" ? <SunIcon /> : <MoonIcon />}
              </button>
            </div>
          </header>

          {children}

          <footer className="ftr">
            {/* The CTO's wording of 19:38Z, not the preview's original: "never logged" is
                defensible about raw values and misleading about the salted fingerprints the
                rate limiter keeps until PURGE_SQL drops them. ui-smoke pins it word for word. */}
            <span>No accounts, no cookies, no trackers. Addresses and IPs are hashed, never stored raw.</span>
            <nav>
              <a href="/donate">Donate TAZ</a>
              {/* Absent unless config validated a maintenance address, so a rejected or unset
                  one shows nothing rather than a link to an empty promise. Real money. */}
              {shown?.maintenanceAddress ? <a href="/fund">Fund ZEC</a> : null}
              {/* A terms page nobody can reach protects nobody. */}
              <a href="/terms">Terms</a>
              <a href="https://github.com/jinolabs-xyz/zcash-faucet" target="_blank" rel="noopener noreferrer">GitHub</a>
            </nav>
            <div className="ftr-attrib">
              <a className="footer-brand" href="https://jinolabs.xyz">
                {/* eslint-disable-next-line @next/next/no-img-element -- a fixed-size SVG from
                    public/ has nothing for next/image to optimise, and Next declines to
                    optimise SVG anyway. The alt text is the brand kit's accessible name. */}
                <img
                  className="lockup"
                  src={theme === "ink" ? "/brand/powered-by-dark.svg" : "/brand/powered-by-light.svg"}
                  alt="Powered by Jino Labs"
                  width={218}
                  height={36}
                />
              </a>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}

/**
 * The badge a page shows before it knows anything.
 *
 * "CHECKING", NEVER "NOT READY", AND THIS IS A RULING RATHER THAN A PREFERENCE (CTO,
 * 21:13Z). The snapshot's static subpage markup ships `data-state="UNKNOWN"` with the words
 * NOT READY, and as a first paint to someone reading the terms with JavaScript disabled
 * that is a false claim about a service that may be perfectly healthy - the same class as a
 * sync figure reading 100% while 44 blocks behind, which is exactly what production did at
 * 20:38Z tonight.
 *
 * The ruling's better branch - render the TRUE word on the server - needs a status read
 * that does not block on the network, and there is none today: `pingBackend` is a live gRPC
 * round trip with no cache layer, `getNodeStatus` has none either, and this repo's own
 * recorded figure is a 2 ms page against 460 to 770 ms for `/api/status`. Putting that in
 * front of a legal page that currently renders from config alone loses to the ruling's own
 * priority: readability of the terms page outranks a live badge. The precondition for the
 * follow-up is an in-process status snapshot cache, which is its own change.
 *
 * The dot is TRANSPARENT with a muted ring, which is the page's existing "no alarm, nothing
 * established" pose, so the colour does not assert health either.
 */
export const CHECKING_BADGE: ShellBadge = {
  word: "CHECKING",
  dot: { fill: "transparent", ring: "color-mix(in srgb, var(--color-text) 45%, transparent)" },
};
