"use client";

import { useEffect, useState } from "react";

interface BalanceResult {
  ok: boolean;
  address?: string;
  kind?: string;
  shielded?: boolean;
  queryable?: boolean;
  balanceTaz?: number;
  note?: string;
  error?: string;
}

export function BalanceTab({ prefill }: { prefill?: string }) {
  const [address, setAddress] = useState(prefill ?? "");
  const [res, setRes] = useState<BalanceResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (prefill) setAddress(prefill);
  }, [prefill]);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setRes(null);
    try {
      const r = await fetch(`/api/balance?address=${encodeURIComponent(address.trim())}`);
      setRes(await r.json());
    } catch {
      setRes({ ok: false, error: "Network error." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="panel" onSubmit={lookup}>
      <label htmlFor="baddr">Check a testnet balance</label>
      <input
        id="baddr"
        type="text"
        placeholder="tm… (transparent) or utest1… / ztestsapling1…"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <button className="cta" type="submit" disabled={loading || !address.trim()}>
        {loading ? "Checking…" : "Check balance"}
      </button>

      {res?.ok && res.queryable ? (
        <div className="result ok">
          💰 <strong>{res.balanceTaz} TAZ</strong> — confirmed balance for this {res.kind} address.
        </div>
      ) : null}
      {res?.ok && res.queryable === false ? (
        <div className="result err">🔒 {res.note}</div>
      ) : null}
      {res && !res.ok ? <div className="result err">⚠️ {res.error}</div> : null}

      <p className="tab-lead" style={{ marginTop: 16 }}>
        Transparent (<code>tm…</code>) balances are public and read live from the chain. Shielded
        balances are private by design — they can’t be looked up from an address alone.
      </p>
    </form>
  );
}
