"use client";

import { useEffect, useState } from "react";

interface NetworkInfo {
  ok: boolean;
  reachable: boolean;
  endpoint?: string;
  chainName?: string;
  version?: string;
  vendor?: string;
  blockHeight?: number;
  estimatedHeight?: number;
  blocksBehind?: number | null;
  synced?: boolean;
  consensusBranchId?: string;
  error?: string;
}

export function NetworkTab() {
  const [info, setInfo] = useState<NetworkInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/network")
        .then((r) => r.json())
        .then((d) => alive && setInfo(d))
        .catch(() => alive && setInfo({ ok: false, reachable: false, error: "unreachable" }));
    load();
    const t = setInterval(load, 15_000); // auto-refresh, like the Aztec faucet
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!info) return <div className="panel tab-lead">Loading network status…</div>;

  if (!info.reachable) {
    return (
      <div className="panel">
        <div className="result err">
          🔌 No lightwalletd endpoint reachable right now.
          {info.error ? <div style={{ marginTop: 6, opacity: 0.8 }}>{info.error}</div> : null}
        </div>
      </div>
    );
  }

  const rows: [string, string][] = [
    ["Chain", info.chainName ?? "—"],
    ["Block height", info.blockHeight?.toLocaleString() ?? "—"],
    ["Estimated tip", info.estimatedHeight?.toLocaleString() ?? "—"],
    ["Blocks behind", info.blocksBehind == null ? "—" : String(info.blocksBehind)],
    ["Consensus branch", info.consensusBranchId ?? "—"],
    ["lightwalletd", `${info.vendor ?? ""} ${info.version ?? ""}`.trim() || "—"],
    ["Endpoint", info.endpoint ?? "—"],
  ];

  return (
    <div className="panel">
      <div className="net-head">
        <span className={`status-dot ${info.synced ? "up" : "down"}`} />
        {info.synced ? "Synced" : "Syncing…"}
        <span className="net-refresh">auto-refresh 15s</span>
      </div>
      <table className="net-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="net-k">{k}</td>
              <td className="net-v">
                <code>{v}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
