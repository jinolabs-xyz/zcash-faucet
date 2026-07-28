<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/banner-paper.svg">
  <img src="docs/banner-ink.svg" alt="Zcash Testnet Faucet. Shielded TAZ from a faucet that runs its own node and wallet.">
</picture>

[![CI](https://github.com/jinolabs-xyz/zcash-faucet/actions/workflows/ci.yml/badge.svg)](https://github.com/jinolabs-xyz/zcash-faucet/actions/workflows/ci.yml)
![network: testnet only](docs/badge-testnet.svg)

Paste a Zcash testnet address, solve a small proof-of-work in the browser, get
TAZ as a shielded z2z transaction. Next.js and TypeScript on the front, a
self-hosted Zebra and Zallet stack behind it. No third-party wallet service and
no captcha vendor.

It mines too, and the reserve loop is built to fund the wallet from what it
mines. On public testnet that does not currently work: one dominant miner wins
every block race, so ours are orphaned and mining income is zero. Measured, not
guessed ([#42](https://github.com/jinolabs-xyz/zcash-faucet/issues/42)). The machinery is real, the revenue is not, so
the wallet is topped up from elsewhere. See [donate](#keeping-it-funded).

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/ready-paper.png">
  <img src="docs/screenshots/ready-ink.png" alt="The faucet ready to serve: address field, Request 0.1 TAZ button, and the live status strip showing node, sync, balance and reserve.">
</picture>

> `zcashd` reached end of life on 2026-07-18 and every node auto-halted. This
> project is built on what replaced it: **Zebra** (full node) and **Zallet**
> (wallet, with the Zaino indexer embedded).

## How it actually works

One box runs four things:

| Piece | What it does |
| --- | --- |
| **Zebra** | Full testnet node. Our own view of the chain, no trusted third party. |
| **Zallet** | Shielded wallet holding the faucet's Orchard notes. Pays via `z_sendmany` over JSON-RPC. Zaino is embedded, so there is no separate indexer process. |
| **Next.js app** | The faucet itself: claim endpoint, anti-abuse gate, reserve loop, UI. |
| **Caddy** | TLS and reverse proxy in front. |

A drip is a real shielded transaction. The faucet holds Orchard notes and pays
z2z, so the amount and the recipient stay off the public ledger, and so does the
link between the faucet and whoever claimed. Transparent recipients still work,
and the UI says plainly that those drips are public.

The public lightwalletd endpoint (`LIGHTWALLETD_ENDPOINT`) is now only used for
the read-side balance lookup tool. Nothing that moves money depends on it.

### Mining and the reserve loop, and why funding does not work yet

A solo CPU Equihash miner (`deploy/z3/miner`, Rust) works `getblocktemplate`
against our own Zebra, and a reserve loop (`src/lib/reserve/`) watches the
spendable balance: below the low-water mark it starts shielding mined coinbase
into the faucet's account, and it stops once the balance reaches target. Two
marks instead of one means the miner does not flap on and off. Refill work goes
through the same serial send queue as drips, one bounded step at a time, and
skips its turn whenever a real claim is waiting, so **topping up never pauses
service**.

That machinery works. The funding does not, and the reason is arithmetic rather
than a bug. We have mined real blocks that our own node accepted, but a single
dominant miner on public testnet wins every height and only ever extends its own
chain, so ours are orphaned. When one miner never builds on your blocks, your
chain advances only when you find a block and theirs advances when they do.
Below half their hashrate the long-run survival of any block you mine is **zero,
not merely small**, so no amount of tuning propagation or template freshness
changes the outcome. The measurement and the maths are in
[#42](https://github.com/jinolabs-xyz/zcash-faucet/issues/42).

What that means in practice: treat mining as machinery that is ready rather than
as an income stream. A deploy that needs a funded wallet has to get TAZ from
somewhere else for now. Mining costs almost nothing to leave running, so it
keeps running and would start funding the faucet the moment the network stops
being dominated by one miner.

### Anti-abuse

The **proof-of-work gate is built and live**, not a plan for later:

- The server issues a challenge signed with HMAC over `RATE_LIMIT_SALT`, so any
  instance can verify one with no shared store.
- The browser finds a nonce whose `sha256(seed:nonce)` has enough leading zero
  bits, in a worker so the tab never freezes.
- Difficulty adapts: a modest base, more bits for a client that keeps hammering,
  more again when the whole faucet is under load, hard-capped so a phone never
  gets a punishing wait.
- Each signed challenge is single use and bound to the salted IP fingerprint it
  was issued to, so a solution cannot be replayed or handed to someone else.

Cloudflare Turnstile is still supported for anyone who prefers it.
`FAUCET_CHALLENGE` picks: `pow`, `turnstile`, or `none`. PoW is the choice for a
self-sovereign deploy because it calls nobody and tracks no one.

Under the gate sit a per-address cooldown and a daily cap, enforced atomically in
one transaction so a burst of simultaneous requests cannot slip past. Rate
limiting is keyed on a **salted hash** of the IP (`src/lib/privacy.ts`), never
the raw address, and the raw IP never reaches a log line.

### The UI

One page (`src/app/page.tsx`), no tabs, with states that tell the truth about
what the backend is doing:

- **Preparing** while the node syncs, with real progress. You can queue a claim
  here and it sends itself once the node is ready.
- **Topping up** while the reserve loop refills. If the faucet can still serve it
  keeps serving and says so, because a healthy background refill must never look
  like an outage.
- **Empty** only when it genuinely cannot pay, and it says the wallet is refilled
  by hand rather than promising a self-heal that mining cannot deliver.
- **Ready**, then a receipt with the txid, a working explorer link, and a
  copyable plain-text summary.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/topping-up.png" alt="The topping-up card: a determinate meter showing spendable against the reserve target, and copy saying the faucet is still serving while it refills."></td>
    <td width="50%"><img src="docs/screenshots/success-receipt.png" alt="The success receipt: amount, recipient, txid, a shielded z to z badge, and buttons to copy the txid or the whole receipt."></td>
  </tr>
  <tr>
    <td><b>Topping up.</b> A refill that can still serve keeps serving, and says so.</td>
    <td><b>Sent.</b> The receipt is the thing you paste into an issue.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/mobile-360.png" width="280" alt="The faucet at 360 pixels wide: the address field, request button and status strip all wrap without horizontal scrolling."></td>
    <td valign="top"><b>360px.</b> The narrowest phone still gets the whole flow, no horizontal scroll, 44px touch targets and a 16px input so iOS does not zoom on focus.</td>
  </tr>
</table>

## Quick start (local, no node needed)

Mock mode runs the whole flow with no keys, no chain, and no wallet.

```bash
npm install
npm run build
FAUCET_SENDER=mock FAUCET_CHALLENGE=pow RATE_LIMIT_SALT=dev-salt npm start
```

Open http://localhost:3000, hit **Generate a test address**, and claim. The mock
sender keeps a simulated balance, so the low-balance guard, the empty state, and
the full claim path are all exercisable.

To watch the reserve loop work, add `FAUCET_MINER_ACTIVE=true
FAUCET_MOCK_REFILL=true` and set the marks low
(`FAUCET_RESERVE_LOW_TAZ=4 FAUCET_RESERVE_TARGET_TAZ=8`).

**`npm run dev` does not bundle.** A `node:` import in `src/lib/zcash/t2z.ts`
breaks the dev webpack build. Use `npm run build && npm start`.

For a real deploy see [deploy/](deploy/): cloud-init for a fresh box, or
`deploy/deploy.sh` to reconcile an existing one.

## Configuration

Every setting is an environment variable, read once at boot. The full table
lives in [CONFIGURATION.md](CONFIGURATION.md), with a working example in
[deploy/z3/faucet.env.example](deploy/z3/faucet.env.example).

## Keeping it funded

Because mining income is zero, the wallet is topped up by hand or by donation.
Two env keys cover it, both optional and both surfaced on `/api/status`:
`FAUCET_DONATION_ADDRESS` is the unified address donations go to, so they arrive
shielded, and `FAUCET_MINING_ADDRESS` is the transparent address the miner pays
its coinbase to, shown for anyone who wants to point spare hashrate at the
faucet. Set either and the UI surfaces it. Set neither and the pages that would
show them say so rather than rendering an empty box.

<img src="docs/screenshots/donate.png" alt="The donate page: the shielded unified address in full with a copy button, a tank gauge showing the reserve level, and the transparent address for anyone pointing a miner at the faucet.">

`/donate` is server rendered, so both addresses are readable with JavaScript
off. That is deliberate for a page whose only job is handing over an address
correctly.

## Operations

The box is meant to look after itself. Details live next to the scripts, this is
the map:

- **Self-healing.** A watchdog restarts wedged services. `/api/health` is
  liveness (is the process answering), `/api/ready` is readiness (can it actually
  serve a drip, with the reason when it cannot). Keeping those separate is what
  stops a normal first sync from looking like an outage.
- **Mining** and its tuning: [deploy/z3/MINING.md](deploy/z3/MINING.md)
- **Encrypted backups** of wallet and ledger: [deploy/z3/BACKUPS.md](deploy/z3/BACKUPS.md)
- **Snapshots** for a fast chain rebuild: [deploy/z3/SNAPSHOTS.md](deploy/z3/SNAPSHOTS.md)
- **TLS and domain**: [deploy/z3/HTTPS.md](deploy/z3/HTTPS.md)
- **Metrics and alerts**: [deploy/z3/OBSERVABILITY.md](deploy/z3/OBSERVABILITY.md)
- **Redeploy with rollback**, and external live monitoring: [deploy/](deploy/)

## Development

Node 23 or newer. Tests run on the built-in runner with native type stripping, so
there is no test framework to install.

```bash
npm run typecheck     # tsc --noEmit
npm test              # unit tests, node --test over src/**/*.test.ts
npm run build         # production build
npm run smoke         # claim flow against an already-running server
npm run test:api      # route-level integration tests, boots the built app itself
```

`npm run smoke` expects a server already up in mock plus pow mode.
`npm run test:api` starts and stops its own servers, so it only needs a build
first.

CI gates every merge: the app job (typecheck, unit tests, build), the smoke job,
shellcheck plus the deploy test harness, and the miner's `cargo test` and clippy.
Branch protection means nothing merges red.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch, PR, and review flow, and
[PRIVACY.md](PRIVACY.md) for exactly what the faucet stores.

## Testnet only

TAZ has no monetary value. Never point this at mainnet, and never reuse a testnet
key anywhere real.
