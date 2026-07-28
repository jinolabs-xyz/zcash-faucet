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
      <button className="btn btn-secondary btn-sm" onClick={() => void copy()}>
        {copied ? "Copied ✓" : "Copy address"}
      </button>
      <span className="sr-only" role="status">{copied ? `${label} copied.` : ""}</span>
    </>
  );
}
