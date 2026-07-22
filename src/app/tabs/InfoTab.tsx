"use client";

import type { Status } from "./types";
import { Copy } from "./Copy";

const FAQ: [string, React.ReactNode][] = [
  [
    "What is TAZ?",
    "TAZ is Zcash testnet currency. It has no monetary value and exists only for testing wallets, apps, and integrations against the Zcash testnet.",
  ],
  [
    "Which address types can I use?",
    <>
      Unified (<code>utest1…</code>) and Sapling (<code>ztestsapling1…</code>) shielded addresses, and
      transparent (<code>tm…</code>/<code>t2…</code>) addresses. Mainnet addresses are rejected.
    </>,
  ],
  [
    "Why can’t I look up a shielded balance?",
    "Shielded balances are private by design — they can’t be derived from an address alone. You need the account’s viewing key, which you’d load into a wallet.",
  ],
  [
    "Is the throwaway account safe to keep?",
    "It’s for testnet only. Keys are generated server-side and never stored — copy them immediately. Never reuse a throwaway key on mainnet.",
  ],
  [
    "How often can I claim?",
    "There’s a per-address and per-IP cooldown, plus a global daily cap, to keep the faucet from being drained.",
  ],
];

export function InfoTab({ status }: { status: Status | null }) {
  const donation = status?.donationAddress;
  return (
    <div className="panel">
      <h3 className="sec-h">Donate — refill the faucet</h3>
      {donation ? (
        <div className="result ok" style={{ marginTop: 0 }}>
          Send TAZ to keep the faucet running:
          <br />
          <code>{donation}</code> <Copy text={donation} />
        </div>
      ) : (
        <p className="tab-lead">
          No donation address is configured yet. Set <code>FAUCET_DONATION_ADDRESS</code> in{" "}
          <code>.env</code> to display the faucet’s receive address here.
        </p>
      )}

      <h3 className="sec-h" style={{ marginTop: 26 }}>
        FAQ
      </h3>
      <div className="faq">
        {FAQ.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <div className="faq-a">{a}</div>
          </details>
        ))}
      </div>
    </div>
  );
}
