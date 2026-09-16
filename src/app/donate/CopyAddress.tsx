"use client";

/**
 * The only interactive part of /donate. Everything else on that page is server
 * rendered so the address is readable with no JavaScript at all, which matters
 * for a page whose entire job is handing over an address.
 */
import { useState } from "react";

/**
 * TWO CONTROLS, TWO CLASSES, because the design has two (#589, from the review of #576).
 *
 * The PANEL control - the one handing over the address the page exists for - is `.automate`
 * in the snapshot (donate.html:428): full width, `calc(3.3*var(--u))` tall, orange, with a
 * `→` from `::after`. The one in the card-copy beside the mining address is `.tag`
 * (donate.html:435), the small chip. I shipped `.tag` for both in #576, which made the page's
 * primary action the same size and weight as its secondary one.
 *
 * `variant` rather than a boolean so the call site says which control it is rather than
 * which one it is not.
 */
export function CopyAddress({
  address,
  label,
  variant = "panel",
}: {
  address: string;
  label: string;
  variant?: "panel" | "chip";
}) {
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
      {/* `.tag`, WHICH IS WHAT THE SNAPSHOT USES for this control (donate.html:482), not the
          legacy `btn btn-secondary btn-sm` from globals.css. Those three classes are styled by
          the retired sheet alone, so the copy button was the one control on these pages still
          wearing the old design.
          DEPARTURE, DECLARED: the snapshot's button also carries `<canvas class="g"
          data-glyph="copy">`. The glyph module lands with #567 and duplicating it here would
          give one component two definitions, so the control ships with the design's shape and
          without its icon, and the icon follows in the slice that owns glyphs. */}
      {/* The arrow the design puts on `.automate` comes from `::after`, so the label is the
          only child here - and the snapshot's `canvas.magic` is `display:none` in its own
          sheet (donate.html:210), so transcribing it would add an element that renders
          nothing. The chip keeps the plain label. */}
      <button className={variant === "panel" ? "automate" : "tag"} type="button" onClick={() => void copy()}>
        <span>{copied ? "Copied ✓" : "Copy address"}</span>
      </button>
      <span className="sr-only" role="status">{copied ? `${label} copied.` : ""}</span>
    </>
  );
}
