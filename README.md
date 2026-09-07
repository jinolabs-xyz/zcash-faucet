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

Most faucets are a form in front of someone else's node. This one owns its whole stack,
a Zebra full node, a Zallet shielded wallet with Zaino embedded, a solo miner, and a
self-healing deployment, so **no third party can move the funds**. The rule it is built
around: **it refuses rather than guesses.** It will not build a payment its node is too
far behind to confirm, and every status field separates *working* from *broken* from
*cannot tell*.

## Architecture

![Faucet system architecture: the drip path across the top (browser, Next.js faucet, fail-closed gates, send queue, sender adapters, ledger) over the self-hosted Z3 stack of Zebra, Zaino, Zallet, a solo miner and a Crosslink node, with the ops layer to the side.](docs/faucet-architecture.png)

## How a drip works

![One drip, end to end: the browser posts an address and proof-of-work, the faucet checks the cooldown, the fail-closed gate reads the node's height and shield recency, and only if safe does the send queue have Zallet build and sign the z2z transaction for Zebra to broadcast, returning a txid and explorer link.](docs/faucet-flow.png)

Nothing gets built until the fail-closed gate proves the node is current enough to
confirm the payment. The full walkthrough is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

| Topic | Doc |
| --- | --- |
| Architecture, the stack, and how a drip works | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Running it, local mock mode and a real server | [DEPLOY.md](DEPLOY.md) |
| Configuration and environment | [CONFIGURATION.md](CONFIGURATION.md) |
| Operator runbook (the box, watchdog, drift, alerts) | [OPERATIONS.md](OPERATIONS.md) |
| Contributing and how it is tested | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Funding and the donation addresses | [docs/FUNDING.md](docs/FUNDING.md) |
| Privacy and security | [PRIVACY.md](PRIVACY.md) · [SECURITY.md](SECURITY.md) |

## Testnet only

TAZ has no monetary value. Never point this at mainnet, and never reuse a testnet key
anywhere real.
