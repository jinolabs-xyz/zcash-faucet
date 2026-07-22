"use client";

import { useState } from "react";
import type { ThrowawayAccount } from "./types";
import { Copy } from "./Copy";

export function AccountTab({ onUseForBalance }: { onUseForBalance?: (addr: string) => void }) {
  const [type, setType] = useState<"transparent" | "shielded">("shielded");
  const [showTransparent, setShowTransparent] = useState(false);
  const [acct, setAcct] = useState<ThrowawayAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState(false);

  async function generate() {
    setLoading(true);
    setAcct(null);
    setRevealed(false);
    try {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const data = await res.json();
      if (data.ok) setAcct(data.account);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel">
      <p className="tab-lead">
        Generate a disposable <strong>shielded</strong> testnet account without a wallet or CLI —
        a real Orchard address + spending key, created server-side and <strong>never stored</strong>.
        Copy the key now.
      </p>

      {showTransparent ? (
        <div className="segmented">
          <button
            type="button"
            className={type === "shielded" ? "seg active" : "seg"}
            onClick={() => setType("shielded")}
          >
            Shielded
          </button>
          <button
            type="button"
            className={type === "transparent" ? "seg active" : "seg"}
            onClick={() => setType("transparent")}
          >
            Transparent
          </button>
        </div>
      ) : (
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={false}
            onChange={() => setShowTransparent(true)}
          />
          Need a transparent (tm…) account instead?
        </label>
      )}

      <button className="cta" onClick={generate} disabled={loading}>
        {loading
          ? type === "shielded"
            ? "Generating shielded account…"
            : "Generating…"
          : "Generate throwaway account"}
      </button>

      {acct ? (
        <div className="result ok" style={{ marginTop: 18 }}>
          <div className="kv">
            <span className="k">Address</span>
            <span className="v">
              <code>{acct.address}</code> <Copy text={acct.address} />
              {acct.mock ? <span className="badge">mock</span> : null}
            </span>
          </div>

          <div className="kv">
            <span className="k">{acct.secretLabel}</span>
            <span className="v">
              <code>{revealed ? acct.secret : "•".repeat(Math.min(acct.secret.length, 40))}</code>{" "}
              <button type="button" className="copy" onClick={() => setRevealed((r) => !r)}>
                {revealed ? "Hide" : "Reveal"}
              </button>{" "}
              {revealed ? <Copy text={acct.secret} /> : null}
            </span>
          </div>

          <p className="warn">⚠️ {acct.warning}</p>

          {!acct.shielded && onUseForBalance ? (
            <button type="button" className="ghost" onClick={() => onUseForBalance(acct.address)}>
              Check this address’s balance →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
