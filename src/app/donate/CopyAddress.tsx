"use client";

/**
 * The only interactive part of /donate. Everything else on that page is server
 * rendered so the address is readable with no JavaScript at all, which matters
 * for a page whose entire job is handing over an address.
 */
import { useState } from "react";

export function CopyAddress({ address, label }: { address: string; label: string }) {
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
      <button className="tag" type="button" onClick={() => void copy()}>
        {copied ? "Copied ✓" : "Copy address"}
      </button>
      <span className="sr-only" role="status">{copied ? `${label} copied.` : ""}</span>
    </>
  );
}
