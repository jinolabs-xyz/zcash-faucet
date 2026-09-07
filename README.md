<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/banner-paper.svg">
  <img src="docs/banner-ink.svg" alt="Zcash Testnet Faucet. Shielded TAZ from a faucet that runs its own node and wallet.">
</picture>

[![CI](https://github.com/jinolabs-xyz/zcash-faucet/actions/workflows/ci.yml/badge.svg)](https://github.com/jinolabs-xyz/zcash-faucet/actions/workflows/ci.yml)
![network: testnet only](docs/badge-testnet.svg)
[![license: MIT](docs/badge-license.svg)](LICENSE)

An open source Zcash testnet faucet you can run yourself. Paste an address, solve a
small proof-of-work in the browser, receive TAZ as a shielded z2z transaction.

Running instance: **[zcashfaucet.jinolabs.xyz](https://zcashfaucet.jinolabs.xyz)**

Most faucets are a form in front of someone else's node. This one owns its whole
stack, a Zebra full node, a Zallet shielded wallet with Zaino embedded, a solo miner,
and a self-healing deployment, so **no third party can move the funds**.

The one rule it is built around: **it refuses rather than guesses.** It will not build
a payment its node is too far behind to confirm, the deploy will not claim success
without checking what it left behind, and every status field separates *working* from
*broken* from *cannot tell*. Only one of those is good news.

> Built on the post-`zcashd` stack (`zcashd` reached end of life on 2026-07-18):
> **Zebra** for the node, **Zallet** for the wallet. Drips are paid from the Ironwood
> shielded pool (NU6.3), where the faucet's notes live.

## Architecture

![Faucet system architecture: the drip path across the top (browser, Next.js faucet, fail-closed gates, send queue, sender adapters, ledger) over the self-hosted Z3 stack of Zebra, Zaino, Zallet, a solo miner and a Crosslink node, with the ops layer to the side.](docs/faucet-architecture.png)

| Piece | Role |
| --- | --- |
| **Zebra** | Full testnet node. Our own view of the chain, no trusted third party. |
| **Zaino** | Light-client indexer, embedded in Zallet, so there is no separate process. |
| **Zallet** | Shielded wallet holding the faucet's notes. Builds and signs every send over JSON-RPC. |
| **Solo miner** | Equihash miner (`deploy/z3/miner`, Rust) that funds the faucet with TAZ it mines itself. |
| **Next.js app + Caddy** | The faucet (claim endpoint, gates, reserve loop, UI) behind TLS. |

The faucet also serves **cTAZ** on the Crosslink testnet, gating on that node's finality
recency and paying through its `requestfaucetdonation` primitive.

## How a drip works

![One drip, end to end: the browser posts an address and proof-of-work, the faucet checks the cooldown, the fail-closed gate reads the node's height and shield recency, and only if safe does the send queue have Zallet build and sign the z2z transaction for Zebra to broadcast, returning a txid and explorer link.](docs/faucet-flow.png)

A drip is a real z2z shielded transaction, so the amount, the recipient, and the link
back to the faucet stay off the public ledger (transparent recipients still work and
are labeled public). Before anything is built, a fail-closed gate checks the node is
current enough to confirm the payment, and if it cannot prove that, the faucet refuses
rather than send a transaction that can never be mined. Sends run one at a time through
a FIFO queue, so two claims never spend the same notes.

## What it does

- **Shielded by default.** Every drip is z2z on the Ironwood pool.
- **Its own node and wallet.** Nothing that moves money depends on a third party. A
  public lightwalletd serves only read-only lookups such as `/api/balance`.
- **Refuses payments that cannot confirm.** The tip is checked against an independent
  reference, and chain-identity and branch-id checks catch a forked or mis-upgraded
  chain rather than paying out on it.
- **Mines and auto-shields its funding.** A solo miner works `getblocktemplate`; a
  reserve loop shields matured coinbase into the wallet, sharing the send queue with
  drips and yielding the moment a real claim arrives.
- **Proof-of-work anti-abuse.** Browser-side PoW with adaptive, subnet-aware
  difficulty and single-use signed challenges. No captcha vendor. (`FAUCET_CHALLENGE`
  also allows `turnstile` or `none`.)
- **Privacy in the rate limiter.** Per-address cooldown and daily cap keyed on a
  salted hash of the IP. The raw address never reaches a log line.
- **Self-healing ops.** Verified chain snapshots every six hours, encrypted backups
  with a restore that has actually been run, and a box that proves it matches the repo.
- **Honest status.** Node, height, balance, miner, box integrity, refill and queue,
  all live off the node, on the page, no login.

## Running it

[DEPLOY.md](DEPLOY.md) has both paths, local mock mode and a real server. Settings are
in [CONFIGURATION.md](CONFIGURATION.md), and [CONTRIBUTING.md](CONTRIBUTING.md) covers
working on it.

## Funding

Testnet TAZ has no market value, so topping up a shared faucet is a small thing that
keeps a tool available for everyone building on Zcash. The addresses are surfaced on
`/donate` and `/fund`, and repeated here so you can verify what the site serves against
a second source. Check them before sending anything.

**Donate TAZ** — testnet, costs the giver nothing, goes back out as drips:

```
utest17rnhex9h0grncus4ax40w2xkmvhz843mvp6c2sp2lcvnup85t9c7n806z099g0hkktx9rgy6cd4z68xthzp5tcz09gvlw4d4m6ynmm0qgj2svdsmw3s6f3d63uur5gyr57kdvnj47gxzsqcc83h6n56gxagen9len4e2dd5rkd36r0s04k56q0zy0gqk0evv06qt9llsqtjsuv2xkgd
```

**Fund the project** — mainnet ZEC for running costs. Real money, and irreversible:

```
u1qj7c2kr4ygv6cn0u5t5gd2kna9q48afg4hwx3reql2fhqmdt6v2pvztcy8xmmklnanlzev7vflxzn72v7eu3vgvj7c9sjwvjkhtecfj0cvryn95cyr9sana9vs07yftgeemrv9uckasjaju4wgsy69u0t6c98cqqtsu3cpmxdyc39qaa
```

**Point a testnet miner here** and the block rewards become drips:

```
tmUiVxo1bbZLP5z6KYfM4dh3PcX5wkd7on8
```

## Operations

Same rule as the app: nothing reports success without checking the state it left
behind, and a check that cannot run says *cannot verify* rather than quietly passing.

- **Deploys refuse rather than report.** `deploy/deploy.sh` will not drop an HTTPS box
  to plain HTTP, never overwrites the wallet account, and proves the end state before
  exiting, including that the wallet rejects a deliberately wrong credential.
- **The box proves it matches the repo.** It publishes what is installed, `/api/status`
  turns it into a verdict, and CI fails when they disagree. Installed-but-not-enabled
  counts as a failure, and a box that cannot say what it has is a failure, not a pass.
- **Versions are pinned where they can be reviewed.** `deploy/z3/stack-versions.env`
  pins the node by version and the wallet by digest; `audit-drift.sh` reports drift.
- **Backups and snapshots.** Encrypted wallet and ledger backups on a timer, with a
  restore that has round-tripped a real wallet. Verified chain snapshots every six
  hours turn a day-long resync into a download plus a short catch-up (snapshot commands
  from our Zebra fork, [Giri-Aayush/zebra](https://github.com/Giri-Aayush/zebra)).

Details live in [deploy/z3/MINING.md](deploy/z3/MINING.md),
[BACKUPS.md](deploy/z3/BACKUPS.md), [SNAPSHOTS.md](deploy/z3/SNAPSHOTS.md),
[HTTPS.md](deploy/z3/HTTPS.md), and [OBSERVABILITY.md](deploy/z3/OBSERVABILITY.md).

## How it is kept honest

Every merge is gated: typecheck, unit tests, route-level integration that boots the
built app and drives the claim flow end to end, shellcheck plus a harness over the
deploy scripts, and the miner's own `cargo test` and clippy. Nothing merges red.

The money path is tested adversarially, not just for a passing case. The send queue is
proven to serialize under a concurrent burst, a proof-of-work challenge is proven to
stay spent across a restart, and a send whose outcome cannot be observed is proven not
to hand out a second drip.

## Testnet only

TAZ has no monetary value. Never point this at mainnet, and never reuse a testnet key
anywhere real.
