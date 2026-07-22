"use client";

import { useEffect, useState } from "react";
import type { Status } from "./tabs/types";
import { FaucetTab } from "./tabs/FaucetTab";
import { AccountTab } from "./tabs/AccountTab";
import { BalanceTab } from "./tabs/BalanceTab";
import { NetworkTab } from "./tabs/NetworkTab";
import { InfoTab } from "./tabs/InfoTab";

type Tab = "faucet" | "account" | "balance" | "network" | "info";

const TABS: { id: Tab; label: string }[] = [
  { id: "faucet", label: "Faucet" },
  { id: "account", label: "Account" },
  { id: "balance", label: "Balance" },
  { id: "network", label: "Network" },
  { id: "info", label: "Donate / FAQ" },
];

export default function Home() {
  const [tab, setTab] = useState<Tab>("faucet");
  const [status, setStatus] = useState<Status | null>(null);
  const [balancePrefill, setBalancePrefill] = useState<string>("");

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  const backendUp = status?.backend.reachable;

  return (
    <div className="wrap">
      <div className="brand">
        <div className="dot">ⓩ</div>
        <h1>Zcash Testnet Faucet</h1>
      </div>
      <p className="sub">
        Free <strong>TAZ</strong> (testnet ZEC, no monetary value) for building and testing on the
        Zcash testnet.
      </p>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "faucet" ? <FaucetTab status={status} /> : null}
      {tab === "account" ? (
        <AccountTab
          onUseForBalance={(addr) => {
            setBalancePrefill(addr);
            setTab("balance");
          }}
        />
      ) : null}
      {tab === "balance" ? <BalanceTab prefill={balancePrefill} /> : null}
      {tab === "network" ? <NetworkTab /> : null}
      {tab === "info" ? <InfoTab status={status} /> : null}

      {status ? (
        <div className="meta">
          <span className="pill">
            <span className={`status-dot ${backendUp ? "up" : "down"}`} />
            backend {backendUp ? "reachable" : "unreachable"}
          </span>
          <span className="pill">network: {status.network}</span>
          <span className="pill">drip: {status.dripTaz} TAZ</span>
          <span className="pill">
            balance: {status.balanceTaz === null ? "—" : `${status.balanceTaz} TAZ`}
          </span>
          <span className="pill">cooldown: {Math.round(status.cooldownSeconds / 3600)}h</span>
        </div>
      ) : null}

      <p className="foot">
        Backend: public lightwalletd endpoint <code>{status?.backend.endpoint ?? "…"}</code>.{" "}
        {status?.sender === "mock" ? (
          <>
            Running in <code>mock</code> mode — no real coins are sent. Set{" "}
            <code>FAUCET_SENDER=real</code> and a funded <code>FAUCET_WALLET_SEED</code> to go live.
          </>
        ) : (
          <>Real sends enabled. Keep the faucet wallet seed server-side only.</>
        )}
      </p>
    </div>
  );
}
