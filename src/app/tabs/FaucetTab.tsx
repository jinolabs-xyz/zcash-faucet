"use client";

import { useEffect, useRef, useState } from "react";
import type { Status } from "./types";

type Result =
  | {
      ok: true;
      txid: string;
      explorerUrl?: string;
      amountTaz: number;
      sender: string;
      to?: { kind?: "unified" | "sapling" | "transparent"; shielded?: boolean };
    }
  | { ok: false; error: string; retryAfterSeconds?: number };

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void }) => string;
    };
    onTurnstileLoad?: () => void;
  }
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

function recipientLabel(kind?: string): string {
  if (kind === "transparent") return "transparent address";
  if (kind === "sapling") return "Sapling shielded address";
  if (kind === "unified") return "unified (shielded) address";
  return "address";
}

export function FaucetTab({ status }: { status: Status | null }) {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState("");
  const widgetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!SITE_KEY || !widgetRef.current) return;
    window.onTurnstileLoad = () => {
      if (widgetRef.current && window.turnstile) {
        window.turnstile.render(widgetRef.current, { sitekey: SITE_KEY, callback: setToken });
      }
    };
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad";
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, turnstileToken: token }),
      });
      setResult(await res.json());
    } catch {
      setResult({ ok: false, error: "Network error. Please try again." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <label htmlFor="addr">Your testnet address — shielded or transparent</label>
      <input
        id="addr"
        type="text"
        placeholder="utest1… / ztestsapling1… / tm…"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />

      {SITE_KEY ? <div className="turnstile" ref={widgetRef} /> : null}

      <button className="cta" type="submit" disabled={loading || !address.trim() || status?.empty}>
        {loading
          ? "Sending…"
          : status?.empty
            ? "Faucet empty — refilling"
            : status
              ? `Send ${status.dripTaz} TAZ`
              : "Send TAZ"}
      </button>

      {status?.empty ? (
        <div className="result err">
          ⛽ The faucet wallet is below its reserve. It’ll be back once refilled.
        </div>
      ) : null}

      {result?.ok ? (
        <div className="result ok">
          ✅ Sent {result.amountTaz} TAZ to your {recipientLabel(result.to?.kind)}
          {result.sender === "mock" ? " (mock)" : ""}.
          {result.txid ? (
            <>
              <br />
              txid: <code>{result.txid}</code>
              {result.explorerUrl ? (
                <>
                  {" "}
                  —{" "}
                  <a href={result.explorerUrl} target="_blank" rel="noreferrer">
                    view on explorer
                  </a>
                </>
              ) : null}
            </>
          ) : (
            <>
              <br />
              <span style={{ color: "var(--muted)" }}>
                Broadcast accepted — it’ll appear in your wallet shortly.
              </span>
            </>
          )}
          {result.to && result.to.shielded === false ? (
            <>
              <br />
              <span style={{ color: "var(--muted)" }}>
                ⚠️ Transparent addresses are public — this transfer is not shielded.
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      {result && !result.ok ? (
        <div className="result err">
          ⚠️ {result.error}
          {result.retryAfterSeconds ? ` (retry in ~${Math.ceil(result.retryAfterSeconds / 60)} min)` : ""}
        </div>
      ) : null}
    </form>
  );
}
