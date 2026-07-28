"use client";

import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";

/* ── Types ─────────────────────────────────────────────────────────────── */
type Phase = "syncing" | "queued" | "empty" | "ready" | "submitting" | "success" | "cooldown" | "error";

interface Status {
  network: string;
  dripTaz: number;
  cooldownSeconds: number;
  sender: string;
  balanceTaz: number | null;
  empty: boolean;
  queueDepth?: number;
  backend: { reachable: boolean; endpoint: string };
  node?: { ready: boolean; syncPercent: number | null; height: number | null; nodeHeight: number | null };
  miner?: { active: boolean };
  reserve?: { targetTaz: number; lowTaz: number; refilling: boolean; spendableTaz: number | null };
  donationAddress?: string;
  challenge?: "pow" | "turnstile" | "none";
}
type CopyTarget = "txid" | "receipt" | "donation";
interface Tx { txid: string; to: string; priv: boolean; explorerUrl?: string; at: number }
interface PowSolution { seed: string; difficulty: number; exp: number; sig: string; nonce: string }

/* ── Helpers ───────────────────────────────────────────────────────────── */
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"; // bech32 charset, for prefix detection

function detect(raw: string) {
  const a = (raw || "").trim();
  const l = a.toLowerCase();
  if (!a) return { kind: "none" as const };
  if (l.startsWith("utest1")) return { kind: "ok" as const, label: "Unified · shielded", priv: true, min: 40 };
  if (l.startsWith("ztestsapling")) return { kind: "ok" as const, label: "Sapling · shielded", priv: true, min: 60 };
  if (/^t[m2]/.test(l)) return { kind: "ok" as const, label: "Transparent · public", priv: false, min: 34 };
  if (/^(u1|zs1|t1|t3)/.test(l)) return { kind: "mainnet" as const };
  return { kind: "unknown" as const };
}
function check(addr: string) {
  const a = addr.trim();
  const d = detect(a);
  if (d.kind === "none") return { ok: false as const };
  if (d.kind === "mainnet")
    return { ok: false as const, err: "That's a mainnet address. This faucet only sends testnet TAZ. Testnet addresses start with utest1, ztestsapling or tm." };
  if (d.kind === "unknown")
    return { ok: false as const, err: "Not a Zcash testnet address. It should start with utest1 (unified), ztestsapling (Sapling) or tm (transparent)." };
  if (a.length < d.min)
    return { ...d, ok: false as const, err: "That address looks cut short: " + a.length + " of about " + d.min + " characters." };
  return { ...d, ok: true as const };
}
function short(a: string, h: number, t: number) { return !a ? "" : a.length <= h + t + 1 ? a : a.slice(0, h) + "…" + a.slice(-t); }
function dur(ms: number) {
  if (ms <= 0) return "a moment";
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + s + "s";
  return s + "s";
}
function num(n: number | null | undefined) { return n == null ? "–" : n.toLocaleString("en-US"); }

const muted = (pct: number): string => `color-mix(in srgb, var(--color-text) ${pct}%, transparent)`;
const PROOF_SECONDS = 12; // estimated shielded-proof build time, for the progress feel

/* ── Component ─────────────────────────────────────────────────────────── */
export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<Phase>("syncing");
  const [addr, setAddr] = useState("");
  const [touched, setTouched] = useState(false);
  const [panel, setPanel] = useState(false);
  const [theme, setTheme] = useState<"paper" | "ink">("ink");
  const [tx, setTx] = useState<Tx | null>(null);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [cooldownEnd, setCooldownEnd] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [errMsg, setErrMsg] = useState("");
  const [tool, setTool] = useState<"lookup" | "about" | null>(null);
  const [lookupAddr, setLookupAddr] = useState("");
  const [lookupRes, setLookupRes] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [powState, setPowState] = useState<{ hashes: number; difficulty: number } | null>(null);
  const [genErr, setGenErr] = useState("");
  const [txSeen, setTxSeen] = useState<{ known: boolean | null; confirmations: number | null } | null>(null);
  // A claim held while the node syncs. Persisted so a reload (or coming back
  // tomorrow) keeps the place in line; fires on its own when the node is ready.
  const [queuedAddr, setQueuedAddr] = useState<string | null>(null);

  const inFlow = useRef(false); // in a claim flow → don't let polling override the phase
  const submitStart = useRef(0);
  const sending = useRef(false);
  const powWorker = useRef<Worker | null>(null);
  const firing = useRef(false); // a queued claim mid-fire, don't fire twice

  const drip = status?.dripTaz ?? 0.1;
  const dripText = (drip % 1 === 0 ? drip.toFixed(0) : String(drip)) + " TAZ";

  const basePhase = useCallback((s: Status | null): Phase => {
    if (!s || !s.backend?.reachable) return "syncing";
    if (s.node && s.node.ready === false) return "syncing";
    if (s.balanceTaz == null) return "syncing";
    if (s.balanceTaz <= 0 || s.empty) return "empty";
    return "ready";
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/status").then((r) => r.json()).then((s) => { if (alive) setStatus(s); }).catch(() => {});
    load();
    const iv = setInterval(load, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  useEffect(() => {
    if (inFlow.current) return;
    const base = basePhase(status);
    // A held claim shows as "queued" while the node syncs; anything else
    // (ready, empty) falls through so the fire effect below can take over.
    setPhase(queuedAddr && base === "syncing" ? "queued" : base);
  }, [status, basePhase, queuedAddr]);

  // Restore a held claim from a previous visit.
  useEffect(() => {
    const saved = localStorage.getItem("zfaucet_queued");
    if (saved && check(saved).ok) setQueuedAddr(saved);
  }, []);
  useEffect(() => {
    if (queuedAddr) localStorage.setItem("zfaucet_queued", queuedAddr);
    else localStorage.removeItem("zfaucet_queued");
  }, [queuedAddr]);

  // The moment the node is ready, a held claim fires through the normal
  // submit path (pow solved fresh here, a solution from queue time would
  // have expired). Once-guarded: polling keeps re-running this effect.
  useEffect(() => {
    if (!queuedAddr || firing.current) return;
    if (basePhase(status) !== "ready") return;
    firing.current = true;
    const target = queuedAddr;
    setQueuedAddr(null);
    setAddr(target);
    void submit(target).finally(() => {
      firing.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, queuedAddr, basePhase]);
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(iv); }, []);
  useEffect(() => {
    if (phase !== "submitting") return;
    const iv = setInterval(() => setElapsed(Date.now() - submitStart.current), 120);
    return () => clearInterval(iv);
  }, [phase]);
  // Ask OUR node whether the drip landed. A public explorer renders a page for
  // any hash, so it cannot answer this (#71).
  useEffect(() => {
    if (!tx?.txid) { setTxSeen(null); return; }
    let alive = true;
    const check = () =>
      fetch("/api/tx?txid=" + encodeURIComponent(tx.txid))
        .then((r) => r.json())
        .then((d) => { if (alive) setTxSeen({ known: d.known ?? null, confirmations: d.confirmations ?? null }); })
        .catch(() => {});
    check();
    const iv = setInterval(check, 10_000);
    return () => { alive = false; clearInterval(iv); };
  }, [tx?.txid]);

  useEffect(() => () => { powWorker.current?.terminate(); powWorker.current = null; }, []);
  useEffect(() => { const t = localStorage.getItem("zfaucet_theme"); if (t === "paper" || t === "ink") setTheme(t); }, []);
  useEffect(() => { localStorage.setItem("zfaucet_theme", theme); }, [theme]);

  // Solve the server's proof-of-work challenge in a worker so the tab never
  // freezes. Resolves with the solution to hand back with the claim.
  const solvePow = () =>
    new Promise<PowSolution>((resolve, reject) => {
      fetch("/api/pow/challenge")
        .then((r) => r.json())
        .then((ch) => {
          if (!ch?.ok) { reject(new Error(ch?.error || "no challenge")); return; }
          setPowState({ hashes: 0, difficulty: ch.difficulty });
          const worker = new Worker("/pow-worker.js");
          powWorker.current = worker;
          worker.onmessage = (e: MessageEvent) => {
            const m = e.data;
            if (m.type === "progress") setPowState((s) => (s ? { ...s, hashes: m.hashes } : s));
            else if (m.type === "found") {
              worker.terminate(); powWorker.current = null;
              resolve({ seed: ch.seed, difficulty: ch.difficulty, exp: ch.exp, sig: ch.sig, nonce: m.nonce });
            }
          };
          worker.onerror = () => { worker.terminate(); powWorker.current = null; reject(new Error("worker error")); };
          worker.postMessage({ seed: ch.seed, difficulty: ch.difficulty });
        })
        .catch(reject);
    });

  const submit = async (target?: string) => {
    const address = (target ?? addr).trim();
    const c = check(address);
    if (!c.ok) { setTouched(true); return; }
    if (sending.current) return;
    // Node still syncing: hold the claim instead of turning the user away.
    // It fires on its own the moment the node is ready (the effect above).
    // `target` set means we ARE the fire, never re-queue.
    if (!target && basePhase(status) === "syncing") {
      setQueuedAddr(address);
      setPhase("queued");
      return;
    }
    sending.current = true;
    inFlow.current = true;
    setElapsed(0); setErrMsg(""); setTouched(false);
    setPhase("submitting");

    // Anti-abuse gate: solve the browser proof-of-work before we ask for coins.
    let pow: PowSolution | undefined;
    if (status?.challenge === "pow") {
      try {
        pow = await solvePow();
      } catch {
        setPowState(null);
        setErrMsg("Couldn't finish the human check. Refresh the page and try again.");
        setPhase("error");
        sending.current = false;
        return;
      }
      setPowState(null);
    }

    submitStart.current = Date.now();
    setElapsed(0);
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, ...(pow ? { pow } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        const d = detect(address);
        setTx({ txid: data.txid, to: address, priv: "priv" in d ? !!d.priv : true, explorerUrl: data.explorerUrl, at: Date.now() });
        setPhase("success");
      } else if (res.status === 429) {
        setCooldownEnd(Date.now() + (data.retryAfterSeconds ?? status?.cooldownSeconds ?? 86400) * 1000);
        setPhase("cooldown");
      } else if (res.status === 503 && /empty/i.test(data.error || "")) {
        inFlow.current = false;
        setPhase("empty");
      } else {
        setErrMsg(data.error || "The send didn't go through. Nothing left the wallet.");
        setPhase("error");
      }
    } catch {
      setErrMsg("Couldn't reach the faucet. Check your connection and try again.");
      setPhase("error");
    } finally {
      sending.current = false;
    }
  };

  const again = () => {
    inFlow.current = false;
    setAddr(""); setTouched(false); setTx(null); setCopied(null); setErrMsg("");
    setQueuedAddr(null);
    setPhase(basePhase(status));
  };

  // Clipboard is unavailable on http origins and in some in-app browsers, so
  // fall back to a hidden textarea rather than silently doing nothing.
  const copy = async (what: CopyTarget, text: string) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setCopied(what);
      setTimeout(() => setCopied(null), 1700);
    } catch {
      setCopied(null);
    }
  };

  /** Plain-text receipt, the thing people actually paste into an issue or chat. */
  const receiptText = (t: Tx) =>
    [
      `Zcash testnet faucet drip`,
      `amount:  ${dripText}`,
      `to:      ${t.to}`,
      `txid:    ${t.txid}`,
      `privacy: ${t.priv ? "shielded (z to z)" : "transparent (public on-chain)"}`,
      `sent:    ${new Date(t.at).toISOString()}`,
      t.explorerUrl ? `explorer: ${t.explorerUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");

  // /api/account answers { ok, account: { address, … } }. Reading d.address
  // instead of d.account.address is what put a fake address in the box and
  // 400'd the most obvious try-it-now flow. There is no sample fallback any
  // more: a synthesized string cannot pass checksum validation, so handing one
  // out only moves the failure somewhere more confusing.
  const generate = async () => {
    setGenErr("");
    try {
      const r = await fetch("/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "shielded" }) });
      const d = await r.json();
      const generated = d?.account?.address;
      if (d?.ok && typeof generated === "string" && check(generated).ok) {
        setAddr(generated);
        setTouched(false);
        return;
      }
      setGenErr(d?.error ?? "Couldn't generate an address just now. Paste one from your wallet, or try again.");
    } catch {
      setGenErr("Couldn't reach the faucet to generate an address. Try again in a moment.");
    }
  };
  const doLookup = async () => {
    const a = lookupAddr.trim();
    if (detect(a).kind !== "ok") { setLookupRes("Not a testnet address, nothing to look up."); return; }
    setLookupRes("Looking up…");
    try {
      const r = await fetch("/api/balance?address=" + encodeURIComponent(a));
      const d = await r.json();
      if (d?.ok === false) setLookupRes(d.error || "Couldn't look that up.");
      else if (d?.shielded && d?.queryable === false) setLookupRes(d.note || "Shielded balances are private. Provide a viewing key in a wallet to see this.");
      else if (typeof d?.balanceTaz === "number") setLookupRes(d.balanceTaz + " TAZ" + (d.kind ? " · " + d.kind : ""));
      else setLookupRes("No balance found for this address.");
    } catch { setLookupRes("Couldn't reach the backend."); }
  };

  /* derived */
  // "queued" is still a syncing node, just with a claim held. The badge and the
  // dot must keep saying so, or the header claims a readiness we do not have.
  const live = phase !== "syncing" && phase !== "queued";
  const node = status?.node;
  const syncPct = node?.syncPercent ?? null;
  const height = node?.height ?? null;
  const nodeHeight = node?.nodeHeight ?? null;
  const balance = status?.balanceTaz ?? 0;
  const reserve = status?.reserve;
  const donation = status?.donationAddress?.trim() ?? "";
  // A refill running while we can still serve must read as healthy, not as an
  // outage. It only changes the copy when the balance is genuinely too low.
  const refilling = !!reserve?.refilling;
  const refillPct =
    reserve && reserve.spendableTaz != null && reserve.targetTaz > 0
      ? Math.min(100, Math.round((reserve.spendableTaz / reserve.targetTaz) * 100))
      : null;
  const c = check(addr);
  const badgeShow = c.ok || ("label" in c && !!c.label);
  const remain = Math.max(0, cooldownEnd - now);

  const proofFrac = phase === "submitting" ? Math.min(sending.current ? 0.95 : 1, elapsed / (PROOF_SECONDS * 1000)) : 0;
  const steps: [string, number][] = [
    ["Checking eligibility", 0.09],
    ["Selecting shielded notes", 0.13],
    ["Building the zero-knowledge proof", 0.63],
    ["Broadcasting to the testnet", 0.15],
  ];
  let acc = 0, curStep = 0;
  const proofSteps = steps.map(([label, w], i) => {
    const from = acc; acc += w;
    const done = proofFrac >= acc, active = !done && proofFrac >= from;
    if (active) curStep = i;
    return { label, mark: done ? "done ✓" : active ? "···" : "", color: done || active ? "var(--color-text)" : muted(40) };
  });
  if (proofFrac >= 1) curStep = steps.length - 1;

  // Honest badge: "TOPPING UP" only when a refill is actually running, "EMPTY"
  // when it isn't. A refill with the balance still serviceable stays "LIVE".
  // Queued is a syncing node with a claim held, so it reads PREPARING too.
  const statusText =
    phase === "syncing" || phase === "queued"
      ? "PREPARING"
      : phase === "empty"
        ? (refilling ? "TOPPING UP" : "EMPTY")
        : "LIVE";
  const dotBg = live && phase !== "empty" ? "var(--color-accent)" : "transparent";

  // One persistent live region announces phase changes to screen readers. It
  // exists from first render (live regions mounted later announce unreliably)
  // and holds a stable sentence per state, so it never spams: no tick counters,
  // no percentages.
  const announce =
    phase === "queued" ? "Your claim is queued. It sends on its own when the node is ready."
    : phase === "syncing" ? "Node is syncing. The faucet will be ready shortly."
    : phase === "empty" ? (refilling ? "Topping up the reserve. Drips resume in a moment." : "The faucet is out of TAZ right now.")
    : phase === "submitting" ? (powState ? "Checking you are human. Nothing to do, it runs on its own." : "Sending your testnet ZEC. Keep this tab open.")
    : phase === "success" ? "Sent. Your testnet ZEC is on its way."
    : phase === "cooldown" ? "Already claimed. This address got its drip in the last 24 hours."
    : phase === "error" ? "The send failed. Nothing left the wallet."
    : "Faucet ready.";

  const pad = "clamp(16px,4vw,26px)";
  const kicker: CSSProperties = { fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--color-accent)" };
  const rowLine: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--color-divider)", fontFamily: "var(--mono)", fontSize: 11.5 };

  return (
    <div
      className={"app " + (theme === "ink" ? "ink" : "")}
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--color-bg)", color: "var(--color-text)", fontFamily: "var(--font-body)" }}
    >
      <header className="nav" style={{ padding: `14px ${pad}`, gap: 14, flexWrap: "wrap" }}>
        <div className="nav-brand" style={{ fontSize: "clamp(15px,4vw,18px)", letterSpacing: "-.01em", marginRight: "auto" }}>Zcash Testnet Faucet</div>
        {/* Not a live region: the sr-only status region in <main> owns phase
            announcements, a live badge here would say everything twice. */}
        <div style={{ display: "flex", alignItems: "center", gap: 7, border: "2px solid var(--color-divider)", padding: "5px 9px", fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: ".1em" }}>
          <span aria-hidden="true" style={{ width: 9, height: 9, flex: "none", background: dotBg, border: "2px solid var(--color-accent)", animation: "pulse 2.6s ease-in-out infinite" }} />
          <span>{statusText}</span>
        </div>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 18px", padding: `9px ${pad}`, borderBottom: "1px solid var(--color-divider)", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".05em", color: muted(55) }}>
        {[
          { k: "node", v: node?.ready ? "ready" : "syncing" },
          { k: "sync", v: syncPct != null ? Math.round(syncPct) + "%" : "–" },
          { k: "height", v: num(height) },
          { k: "balance", v: balance ? balance.toFixed(1) + " TAZ" : "0 TAZ" },
          { k: "miner", v: status?.miner?.active ? "on" : "off" },
          ...(reserve
            ? [
                {
                  k: "reserve",
                  // "ok" would be a lie under the low mark with no refill running
                  // (miner off), so that case reads "low" instead.
                  v: refilling
                    ? "topping up"
                    : reserve.spendableTaz != null && reserve.spendableTaz < reserve.lowTaz
                      ? "low"
                      : "ok",
                },
              ]
            : []),
        ].map((it) => (
          <span key={it.k}>{it.k} <b style={{ color: "var(--color-text)", fontWeight: 700 }}>{it.v}</b></span>
        ))}
        <button className="btn btn-ghost btn-sm" onClick={() => setPanel((p) => !p)} aria-expanded={panel} aria-controls="live-panel" style={{ marginLeft: "auto", padding: 0 }}>{panel ? "Hide live panel ▴" : "Live panel ▾"}</button>
      </div>

      {panel && (
        <div id="live-panel" style={{ borderBottom: "2px solid var(--color-divider)", background: "var(--color-surface)", padding: `16px ${pad}` }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 26px", maxWidth: 820 }}>
            {[
              { k: "node", v: node?.ready ? "ready" : "syncing" + (syncPct != null ? " (" + Math.round(syncPct) + "%)" : "") },
              { k: "block height", v: num(height) + (nodeHeight ? " / " + num(nodeHeight) : "") },
              { k: "wallet balance", v: (status?.balanceTaz ?? 0).toFixed(2) + " TAZ" },
              { k: "miner", v: status?.miner?.active ? "on" : "off" },
              ...(reserve
                ? [
                    { k: "reserve", v: (reserve.spendableTaz ?? 0).toFixed(1) + " / " + reserve.targetTaz.toFixed(0) + " TAZ" },
                    { k: "refill", v: refilling ? "topping up" : "idle" },
                  ]
                : []),
              { k: "queue", v: (status?.queueDepth ?? 0) + " pending" },
              { k: "backend", v: status?.backend?.reachable ? "reachable" : "unreachable" },
            ].map((r) => (
              <div key={r.k} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "7px 0", borderBottom: "1px solid var(--color-divider)", fontFamily: "var(--mono)", fontSize: 11 }}>
                <span style={{ color: muted(55) }}>{r.k}</span><span style={{ fontWeight: 700, textAlign: "right" }}>{r.v}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginTop: 14 }}>
            <span className="tag tag-outline">Own node, own wallet, shielded drips</span>
            <span style={{ fontSize: 11.5, color: muted(55) }}>Numbers come straight off the node. Refreshes every few seconds.</span>
          </div>
        </div>
      )}

      <main style={{ flex: 1, width: "100%", maxWidth: 620, margin: "0 auto", padding: `clamp(22px,5vw,46px) ${pad} 60px`, display: "flex", flexDirection: "column", gap: 20 }}>
        <p className="sr-only" role="status">{announce}</p>
        {(phase === "ready" || phase === "syncing" || phase === "empty") && (
          <div>
            <h1 style={{ fontSize: "clamp(27px,7.4vw,40px)", lineHeight: 1.08, letterSpacing: "-.025em", margin: "0 0 10px" }}>Get free testnet ZEC, sent privately.</h1>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55, color: muted(62), maxWidth: "44ch" }}>Paste a Zcash testnet address. The drip goes out as a shielded transaction, so the amount and the recipient stay off the public ledger.</p>
          </div>
        )}

        {phase === "syncing" && (
          <div style={{ border: "2px solid var(--color-divider)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <span style={kicker}>Getting ready</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700 }}>{syncPct != null ? Math.round(syncPct) + "%" : "starting…"}</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 18, lineHeight: 1.25 }}>Syncing the node. The faucet will be ready shortly.</h2>
            <div role="progressbar" aria-label="Node sync progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={syncPct != null ? Math.round(syncPct) : undefined} style={{ height: 10, border: "2px solid var(--color-divider)", position: "relative", overflow: "hidden" }}>
              <i aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: syncPct != null ? Math.round(syncPct) + "%" : "100%", background: "repeating-linear-gradient(135deg,var(--color-accent) 0 3px,transparent 3px 7px)", backgroundSize: "26px 26px", animation: "hatch 1.1s linear infinite", opacity: syncPct != null ? 1 : 0.55 }} />
            </div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: muted(60) }}>
              {height != null ? "Block " + num(height) + (nodeHeight ? " of " + num(nodeHeight) : "") + " · " : "Bringing the node online · "}first sync takes a while, one time. It becomes the real faucet automatically.
            </p>
          </div>
        )}

        {phase === "queued" && queuedAddr && (
          <div style={{ border: "2px solid var(--color-text)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <span style={kicker}>Queued</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700 }}>{syncPct != null ? Math.round(syncPct) + "%" : "syncing…"}</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 18, lineHeight: 1.25 }}>You&apos;re in line. It sends on its own.</h2>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(62) }}>
              The moment the node is ready, {dripText} goes to <span style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{short(queuedAddr, 12, 6)}</span>. Keep this tab open or come back later, your place survives a reload.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => { setQueuedAddr(null); setPhase(basePhase(status)); }}>Cancel and change address</button>
            </div>
          </div>
        )}

        {phase === "ready" && refilling && (
          <div style={{ border: "1px solid var(--color-divider)", padding: "10px 14px", display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px", fontFamily: "var(--mono)", fontSize: 11.5 }}>
            <span style={{ ...kicker, fontSize: 10 }}>Topping up</span>
            <span style={{ color: muted(60) }}>The reserve is being topped up in the background. Claims are unaffected.</span>
            {refillPct != null && <span style={{ fontWeight: 700, marginLeft: "auto" }}>{refillPct}%</span>}
          </div>
        )}

        {phase === "empty" && refilling && (
          <div style={{ border: "2px solid var(--color-divider)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <span style={kicker}>Topping up</span>
              {reserve && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700 }}>
                  {(reserve.spendableTaz ?? 0).toFixed(1)} / {reserve.targetTaz.toFixed(0)} TAZ
                </span>
              )}
            </div>
            <h2 style={{ margin: 0, fontSize: 18, lineHeight: 1.25 }}>Topping up the reserve. Drips resume in a moment.</h2>
            {refillPct != null && (
              <div role="progressbar" aria-label="Reserve refill progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={refillPct} style={{ height: 10, border: "2px solid var(--color-divider)", position: "relative", overflow: "hidden" }}>
                <i aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: refillPct + "%", background: "repeating-linear-gradient(135deg,var(--color-accent) 0 3px,transparent 3px 7px)", backgroundSize: "26px 26px", animation: "hatch 1.1s linear infinite" }} />
              </div>
            )}
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(62) }}>The faucet is mining and shielding its own coins right now. Nothing is broken. The balance dipped below the reserve line and it is being restored automatically.</p>
          </div>
        )}

        {phase === "empty" && !refilling && (
          <div style={{ border: "2px solid var(--color-divider)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 9 }}>
            <span style={kicker}>Empty</span>
            <h2 style={{ margin: 0, fontSize: 18, lineHeight: 1.25 }}>The faucet is out of TAZ right now.</h2>
            {/* Do not promise this fixes itself. The miner runs, but on public
                testnet a dominant miner orphans every block we win, so mining
                income is zero (#42) and the wallet is refilled by hand. Saying
                otherwise sends people away expecting a recovery that is not
                coming. */}
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(62) }}>
              It gets refilled by hand at the moment, so this can take a while. Nothing you did caused
              it{donation ? ", and if you have spare TAZ the address below puts the faucet back up for everyone" : ""}.
            </p>
            {donation && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 10px", fontFamily: "var(--mono)", fontSize: 11.5 }}>
                <span style={{ color: muted(55) }}>top it up</span>
                <span style={{ fontWeight: 700, wordBreak: "break-all" }}>{short(donation, 16, 8)}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => void copy("donation", donation)} style={{ padding: 0 }}>
                  {copied === "donation" ? "Copied ✓" : "Copy address"}
                </button>
                <a className="btn btn-ghost btn-sm" href="/donate" style={{ padding: 0 }}>Why, and how it helps →</a>
              </div>
            )}
          </div>
        )}

        {(phase === "ready" || phase === "syncing" || phase === "empty") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            <label htmlFor="zaddr" style={{ ...kicker, color: muted(60) }}>Your testnet address</label>
            <input id="zaddr" className="input" type="text" spellCheck={false} autoComplete="off" autoCapitalize="off" placeholder="utest1… / ztestsapling… / tm…" value={addr} onChange={(e) => { setAddr(e.target.value); setTouched(false); }} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} aria-describedby="addrmsg" />
            <div id="addrmsg" aria-live="polite" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 9, minHeight: 24 }}>
              {badgeShow && "label" in c && <span className="tag tag-outline">{c.label}</span>}
              {"priv" in c && c.priv === false && <span style={{ fontSize: 12, lineHeight: 1.45, color: muted(62) }}>Transparent address, so this drip will be visible on-chain.</span>}
              {touched && "err" in c && c.err && <span style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--color-accent-700)", fontWeight: 500, maxWidth: "52ch" }}>{c.err}</span>}
              {genErr && <span style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--color-accent-700)", fontWeight: 500, maxWidth: "52ch" }}>{genErr}</span>}
              {!addr.trim() && <button className="btn btn-ghost btn-sm" onClick={generate} style={{ padding: 0 }}>Generate a test address</button>}
            </div>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={phase === "empty"} style={{ width: "100%", justifyContent: "space-between" }}>
              <span>{phase === "syncing" ? "Queue it, sends when the node is ready" : phase === "empty" ? (refilling ? "Topping up, back in a moment" : "Waiting for a refill") : "Request " + dripText}</span>
              <span aria-hidden="true">→</span>
            </button>
            <p style={{ margin: 0, fontSize: 11.5, letterSpacing: ".02em", color: muted(55), fontFamily: "var(--mono)" }}>{dripText} · once per address / 24h · shielded z→z</p>
          </div>
        )}

        {phase === "submitting" && powState && (
          <div style={{ border: "2px solid var(--color-text)", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 13 }}>
            <span style={kicker}>Human check, no CAPTCHA</span>
            <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.25 }}>Checking you&apos;re human…</h2>
            <div style={{ height: 10, border: "2px solid var(--color-text)", position: "relative", overflow: "hidden" }}>
              <i style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, background: "repeating-linear-gradient(135deg,var(--color-accent) 0 3px,transparent 3px 7px)", backgroundSize: "26px 26px", animation: "hatch .9s linear infinite" }} />
            </div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: muted(62) }}>Your browser is solving a small cryptographic puzzle so bots cannot drain the faucet. Nothing to click, nothing tracked. It runs on its own.</p>
            <p style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 11, color: muted(50) }}>difficulty {powState.difficulty} bits · {powState.hashes.toLocaleString("en-US")} hashes</p>
          </div>
        )}

        {phase === "submitting" && !powState && (
          <div style={{ border: "2px solid var(--color-text)", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 13 }}>
            <span style={kicker}>Sending, keep this tab open</span>
            <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.25 }}>{steps[curStep][0]}…</h2>
            <div style={{ height: 10, border: "2px solid var(--color-text)", position: "relative", overflow: "hidden" }}>
              <i style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: Math.round(proofFrac * 100) + "%", background: "repeating-linear-gradient(135deg,var(--color-accent) 0 3px,transparent 3px 7px)", backgroundSize: "26px 26px", animation: "hatch .9s linear infinite" }} />
            </div>
            <div>
              {proofSteps.map((s, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: "1px solid var(--color-divider)", fontFamily: "var(--mono)", fontSize: 11.5, color: s.color }}>
                  <span>{s.label}</span><span>{s.mark}</span>
                </div>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: muted(62) }}>A shielded send builds a zero-knowledge proof before it can be broadcast. That is the wait. It is doing the privacy work.</p>
          </div>
        )}

        {phase === "success" && tx && (
          <div style={{ border: "2px solid var(--color-text)", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: 16, borderBottom: "2px solid var(--color-text)", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, background: "var(--color-surface)" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase" }}>Sent ✓</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em", color: muted(55) }}>just now</span>
            </div>
            <div style={{ padding: "18px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontSize: "clamp(30px,8vw,42px)", fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1 }}>{dripText}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: muted(55) }}>on its way</span>
              </div>
              <div>
                {/* Full values in title + a copyable receipt below: the shortened
                    forms are for reading, never the only way to get the data. */}
                <div style={rowLine}><span style={{ color: muted(55) }}>to</span><span title={tx.to} style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>{short(tx.to, 12, 6)}</span></div>
                <div style={rowLine}><span style={{ color: muted(55) }}>txid</span><span title={tx.txid} style={{ fontWeight: 700 }}>{short(tx.txid, 10, 8)}</span></div>
                <div style={rowLine}>
                  <span style={{ color: muted(55) }}>our node</span>
                  <span style={{ fontWeight: 700, textAlign: "right", maxWidth: "62%" }}>
                    {txSeen === null
                      ? "checking…"
                      : txSeen.known === true
                        ? txSeen.confirmations
                          ? `seen it, ${txSeen.confirmations} confirmation${txSeen.confirmations === 1 ? "" : "s"}`
                          : "seen it, in the mempool"
                        : txSeen.known === false
                          ? "not seen yet"
                          : "cannot say right now"}
                  </span>
                </div>
                <div style={rowLine}>
                  <span style={{ color: muted(55) }}>privacy</span>
                  <span style={{ fontWeight: 700, textAlign: "right", maxWidth: "62%" }}>
                    {tx.priv ? <span className="tag tag-outline" style={{ fontSize: 9 }}>shielded z→z</span> : "transparent, public on-chain"}
                  </span>
                </div>
                <div style={rowLine}><span style={{ color: muted(55) }}>network</span><span style={{ fontWeight: 700 }}>{status?.network ?? "testnet"}</span></div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => void copy("txid", tx.txid)}>{copied === "txid" ? "Copied ✓" : "Copy txid"}</button>
                <button className="btn btn-secondary btn-sm" onClick={() => void copy("receipt", receiptText(tx))}>{copied === "receipt" ? "Copied ✓" : "Copy receipt"}</button>
                {tx.explorerUrl && <a className="btn btn-secondary btn-sm" href={tx.explorerUrl} target="_blank" rel="noreferrer">Open in explorer ↗</a>}
                <button className="btn btn-ghost btn-sm" onClick={again} style={{ padding: 0 }}>Another address</button>
              </div>
              <p aria-live="polite" className="sr-only">{copied === "txid" ? "Transaction id copied." : copied === "receipt" ? "Receipt copied." : ""}</p>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: muted(55) }}>
                {tx.priv
                  ? "Shielded sends take a moment to show up in an explorer, and the amount stays private there."
                  : "It can take a minute to appear in an explorer while the transaction is mined."}
              </p>
            </div>
          </div>
        )}

        {phase === "cooldown" && (
          <div style={{ border: "2px solid var(--color-divider)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={kicker}>Already claimed</span>
            <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.25 }}>Come back in {dur(remain)}.</h2>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(62) }}>One drip per address every 24 hours keeps the faucet standing up for everybody. <span style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{short(addr.trim(), 10, 6)}</span> got its {dripText}.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}><button className="btn btn-secondary btn-sm" onClick={again}>Try a different address</button></div>
          </div>
        )}

        {phase === "error" && (
          <div role="alert" style={{ border: "2px solid var(--color-accent)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 11 }}>
            <span style={kicker}>Send failed, nothing left the wallet</span>
            <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.25 }}>That didn&apos;t go through.</h2>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: muted(70), maxWidth: "52ch" }}>{errMsg}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <button className="btn btn-primary btn-sm" onClick={() => void submit()}>Try again</button>
              <button className="btn btn-ghost btn-sm" onClick={again} style={{ padding: 0 }}>Start over</button>
            </div>
          </div>
        )}

        <div className="hr" style={{ margin: "6px 0 0" }} />

        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => { setTool((t) => (t === "lookup" ? null : "lookup")); setLookupRes(""); }} aria-expanded={tool === "lookup"} aria-controls="tool-lookup" style={{ padding: 0 }}>Balance lookup</button>
          <button className="btn btn-ghost btn-sm" onClick={generate} style={{ padding: 0 }}>Generate a test address</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setTool((t) => (t === "about" ? null : "about"))} aria-expanded={tool === "about"} aria-controls="tool-about" style={{ padding: 0 }}>How it works</button>
        </div>

        {tool === "lookup" && (
          <div id="tool-lookup" style={{ border: "2px solid var(--color-divider)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <label htmlFor="lk" style={{ ...kicker, color: muted(60) }}>Balance lookup</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <input id="lk" className="input" type="text" spellCheck={false} placeholder="any testnet address" value={lookupAddr} onChange={(e) => { setLookupAddr(e.target.value); setLookupRes(""); }} style={{ flex: "1 1 220px", minHeight: 44 }} />
              <button className="btn btn-secondary btn-sm" onClick={doLookup} style={{ minHeight: 44 }}>Look up</button>
            </div>
            {lookupRes && <p style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.5 }}>{lookupRes}</p>}
          </div>
        )}

        {tool === "about" && (
          <div id="tool-about" style={{ border: "2px solid var(--color-divider)", padding: 14, display: "flex", flexDirection: "column", gap: 9 }}>
            <span style={{ ...kicker, color: muted(60) }}>How it works</span>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: muted(72) }}>This faucet runs its own node and wallet, and it mines testnet blocks. It does not currently earn from mining: a dominant miner wins every block race on public testnet, so the blocks it wins are orphaned. The TAZ it hands out is donated or topped up by hand, which is why it can run empty and why it says so plainly when it does.</p>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: muted(72) }}>Drips leave as shielded (z→z) transactions. The amount and the recipient never touch the public ledger, which is also why a send takes about ten seconds: it is building the zero-knowledge proof that makes that possible.</p>
          </div>
        )}

        <p style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: ".05em", color: muted(45) }}>Testnet only. TAZ has no monetary value.</p>
      </main>

      <div style={{ position: "sticky", bottom: 0, borderTop: "2px solid var(--color-divider)", background: "var(--color-surface)", padding: `10px ${pad}`, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".05em", color: muted(50) }}>{status?.network ?? "testnet"} · {status?.sender ?? "…"} backend</span>
        <a className="btn btn-ghost btn-sm" href="/donate" style={{ padding: 0 }}>Donate TAZ</a>
        <button className="btn btn-secondary btn-sm" onClick={() => setTheme((t) => (t === "ink" ? "paper" : "ink"))} aria-label={theme === "ink" ? "Switch to paper (light) theme" : "Switch to ink (dark) theme"} style={{ marginLeft: "auto" }}>{theme === "ink" ? "Paper" : "Ink"}</button>
      </div>
    </div>
  );
}
