# Zcash Testnet Faucet: Frontend Design Spec

A brief for designing the faucet's web UI. Hand this to a designer (or Claude
design) to produce the visual design, and we build from that.

---

## 1. What it is, in one line

A **shielded, self-mining Zcash testnet faucet**: a developer pastes a testnet
address, and receives free test coins (TAZ) sent **privately** to their wallet.
Think "Sepolia faucet, but privacy-first and honest about its own state."

## 2. Who uses it

- **Primary: developers** building/testing Zcash apps and SDKs. They want TAZ
  *fast*, with zero friction, often on **mobile** (checking on a phone while
  coding on a laptop). Technical, but impatient. They don't want a tutorial.
- **Secondary: the operator** (us), who wants the faucet's live health visible
  at a glance without SSH.

## 3. Design principles

1. **One job, done in 5 seconds.** Paste address → get coins. Everything else is
   secondary and must not get in the way of that.
2. **Radically honest about state.** This faucet is transparent about what it's
   doing right now: syncing, mining, funded, empty, sending. Never fake a
   number, never hide a problem. Honesty *is* the brand.
3. **Privacy-first, and it shows.** Shielded-by-default. The UI should *feel*
   private and secure: calm, deliberate, not shouty. Reinforce that funds go
   out privately (z→z).
4. **Trustworthy, not corporate.** Clean, technical, a little bit crypto-native.
   No stock illustrations, no marketing fluff, no dark patterns.
5. **Mobile-first.** Assume a phone screen first, scale up to desktop.

## 4. The core flow (the 80% path)

This is the screen that matters. Keep it to one view, no scrolling to act.

```
   ┌───────────────────────────────────────────┐
   │  Zcash Testnet Faucet            ● live    │   ← header + live status dot
   │                                            │
   │  Get free testnet ZEC, sent privately.     │   ← one-line value prop
   │                                            │
   │  ┌──────────────────────────────────────┐  │
   │  │ utest1… / ztestsapling… / tm…        │  │   ← the address input (big)
   │  └──────────────────────────────────────┘  │
   │  [        Request 0.1 TAZ  →             ]  │   ← primary CTA
   │                                            │
   │  0.1 TAZ · once per 24h · shielded         │   ← the terms, tiny + calm
   └───────────────────────────────────────────┘
```

- The **address field** is the hero. Big, obvious, forgiving (trims whitespace,
  detects address type live and shows a small badge: "Unified · shielded",
  "Sapling · shielded", "Transparent · public").
- The **button** shows the drip amount. On submit it becomes a **progress**
  state (see §6: a shielded send takes ~10s to build its zero-knowledge proof,
  and the UI must make that wait feel intentional, not broken).
- **No captcha wall by default.** (Anti-abuse is a per-IP cooldown + daily cap,
  and a proof-of-work challenge may be added later. Design a slot for an optional
  inline "verifying you're human" step, but don't center it.)

## 5. States to design (this is the important part)

The faucet moves through real states. Each needs a distinct, honest treatment.
Design these as variations of the core screen: same layout, different status.

| State | What's true | How it should feel / say |
|---|---|---|
| **Preparing / syncing** | Node is syncing the chain (show %) | Calm, reassuring, *with a progress indicator*: "Getting ready: syncing the node (34%)." Input disabled or queued. **This is on screen right now and must look intentional, not broken.** |
| **Empty** | Node ready, but wallet not funded yet | Honest: "The faucet is refilling. Check back shortly." Optionally show how it funds itself (see §9). |
| **Ready** | Funded, idle | The default hero. Confident, inviting. |
| **Submitting** | Building the shielded proof (~10s) | A deliberate progress state: "Building your private transaction…" with motion. Must not look hung. |
| **Success** | Sent | A **receipt**: amount, shortened txid (copyable), explorer link, "sent privately to your shielded address ✓". Celebratory but restrained. |
| **Cooldown** | This address/IP already claimed | A friendly countdown: "You've claimed. Come back in 23h 41m." |
| **Error** | Send failed / backend down | Plain, specific, non-scary. Surface the real reason if useful, and offer retry. |

The **status** is a first-class element, not a footnote. A small always-visible
**status pill/dot** in the header (green live / amber preparing / red down),
plus a compact **live panel** the curious can expand: node sync %, wallet
balance (TAZ), and (nice touch) that it **mines its own coins**.

## 6. Components

- **Address input**: large, monospace-friendly, live type detection + validity
  badge, paste-friendly, clear error text under the field.
- **Primary button**: one clear CTA that carries the amount, with
  loading/progress, disabled, and success variants.
- **Status pill + expandable live panel**: node sync %, balance, mining
  indicator, backend reachability. Auto-refreshes.
- **Receipt card**: txid (truncated + copy), explorer link, privacy confirmation.
- **Cooldown timer**: human countdown.
- **Tiny secondary utilities** (can be tucked in tabs/footer, low priority):
  balance lookup for any address, a "generate a test address" helper, network
  status, an About/how-it-works.

## 7. Visual direction

Explore freely, but anchor to:

- **Zcash identity** without being a clone: the Zcash gold/yellow (#F4B728-ish)
  as an accent, not a flood. Pair it with a deep, near-black shielded background
  for the default (dark feels right for a privacy tool), with a clean light
  mode too.
- **Type**: a crisp technical sans for UI, a mono for addresses/txids. Confident
  hierarchy: the address field and CTA dominate.
- **Mood**: calm, precise, a little bit "night-mode terminal meets fintech." Lots
  of breathing room. Motion is subtle and purposeful (the proving/sending wait is
  where motion earns its place).
- **No**: stock photos, 3D coins, gradients-for-gradients'-sake, emoji-as-design.

## 8. Content & tone

- Short, direct, human. "Get free testnet ZEC, sent privately." not "Leverage our
  robust faucet infrastructure."
- Be specific in errors ("This address already claimed, try again in 23h") over
  generic ("Something went wrong").
- Teach lightly: a one-liner on *why shielded* for the curious, never in the way.

## 9. Trust & what makes this one different (worth surfacing subtly)

- **Shielded by default**: recipients get private funds (z→z). Say it once, clearly.
- **Self-mining**: this faucet mines its own testnet coins, so it doesn't beg
  other faucets. That's a genuine trust/independence signal, worth a quiet badge
  or a line in the live panel ("self-funded · mines its own TAZ").
- **Honest status**: the visible live state is itself a trust signal. Lean into it.

## 10. Responsive & accessibility

- **Mobile-first**: the core flow must be thumb-friendly, single-column, CTA
  reachable. Test at 360px wide.
- **Accessible**: proper contrast in both themes, focus states, labels, the
  status conveyed by text+icon (not color alone), respects reduced-motion.
- **Fast**: no heavy assets. It should feel instant.

## 11. Out of scope for v1 (don't over-design)

Accounts/login, history dashboards, multi-network switching, theming controls.
One page, one job, honest status. Everything else earns its way in later.

---

### Deliverables we'd want back

- The **core claim screen** in its key states: ready, submitting, success, cooldown.
- The **preparing/syncing** state (with the live status treatment).
- **Mobile + desktop**, **dark + light**.
- The reusable **components** (input, button, status pill/panel, receipt).
