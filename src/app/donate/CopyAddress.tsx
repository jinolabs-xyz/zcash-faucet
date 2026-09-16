"use client";

/**
 * The only interactive part of /donate. Everything else on that page is server
 * rendered so the address is readable with no JavaScript at all, which matters
 * for a page whose entire job is handing over an address.
 */
import { useState } from "react";

/**
 * `variant` is REQUIRED rather than defaulted, and that is the point of it. The snapshot uses
 * two different controls for two different jobs and this one component renders both; a default
 * would let a third call site pick the wrong one silently, which is how all three ended up in
 * `.tag` in the first place.
 *
 *   panel  donate.html:428, fund.html:428   `.automate` - the page's primary action, full width
 *   chip   donate.html:435                  `.tag` - the mining address, a secondary chip
 */
export function CopyAddress({ address, label, variant }: { address: string; label: string; variant: "panel" | "chip" }) {
  const [copied, setCopied] = useState(false);

  // Clipboard is unavailable on http origins and in some in-app browsers, so
  // fall back to a hidden textarea rather than a button that does nothing.
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(address);
      else {
        const ta = document.createElement("textarea");
        ta.value = address;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1700);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      {/* TWO CONTROLS, NOT ONE. The earlier comment here cited `donate.html:482` for `.tag` and
          put BOTH copy buttons in it. The snapshot uses `.automate` for the panel control
          (donate.html:428, fund.html:428 - full width, 3.3u tall, the accent fill) and `.tag`
          only for the mining chip (donate.html:435). Because the app had no `.automate` rule at
          the time, the panel control rendered at 30.1px against the design's 46.2, and everything
          below it on /donate and /fund sat 16.1px high - a whole control's worth of layout, from
          one class.

          `.automate` now ships in redesign-card.css (S2b) and Shell.tsx imports that sheet on
          every page, so this is a class swap and not a transcription: adding the rule again here
          would give one selector two definitions, which is the thing #576 and #586 were both
          about.

          DEPARTURES, BOTH DECLARED. The snapshot's panel control carries
          `<canvas class="magic" data-sparkle-icon>` and the chip carries
          `<canvas class="g" data-glyph="copy">`; we ship neither icon. The panel's is hidden by
          the design's own `.automate canvas.magic{display:none}` so it is invisible either way,
          and the chip's is the glyph module's to add. `data-accent` is carried because our index's
          claim button carries it and the snapshot does too; nothing in either sheet styles it, so
          it is inert markup kept for consistency rather than for effect. */}
      {variant === "panel" ? (
        <button className="automate" data-accent type="button" onClick={() => void copy()}>
          <span>{copied ? "Copied ✓" : "Copy address"}</span>
        </button>
      ) : (
        <button className="tag" type="button" onClick={() => void copy()}>
          {copied ? "Copied ✓" : "Copy address"}
        </button>
      )}
      <span className="sr-only" role="status">{copied ? `${label} copied.` : ""}</span>
    </>
  );
}
