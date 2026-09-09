# Architecture

How the faucet is put together and why it behaves the way it does. For the operator
runbook see [OPERATIONS.md](../OPERATIONS.md); for deploying see [DEPLOY.md](../DEPLOY.md).

## The stack

![Faucet system architecture: the drip path across the top (browser, Next.js faucet, fail-closed gates, send queue, sender adapters, ledger) over the self-hosted Z3 stack of Zebra, Zaino, Zallet, a solo miner and a Crosslink node, with the ops layer to the side.](faucet-architecture.png)

| Piece | Role |
| --- | --- |
| **Zebra** | Full testnet node. Our own view of the chain, no trusted third party. |
| **Zaino** | Light-client indexer, embedded in Zallet, so there is no separate process. |
| **Zallet** | Shielded wallet holding the faucet's Ironwood-pool notes. Builds and signs every send over JSON-RPC. |
| **Solo miner** | Equihash miner (`deploy/z3/miner`, Rust) that funds the faucet with TAZ it mines itself. |
| **Next.js app + Caddy** | The faucet (claim endpoint, gates, reserve loop, UI) behind TLS. |

The faucet also serves **cTAZ** on the Crosslink testnet, gating on that node's finality
recency and paying through its `requestfaucetdonation` primitive. The public
lightwalletd endpoint (`LIGHTWALLETD_ENDPOINT`) serves the read-side balance lookup, and
a public TLS endpoint on the list is also the tip oracle's fallback when the hosh
aggregate is dark and the source of expiry heights, so it does touch the drip gate.
Sending itself never uses it: a drip is built and broadcast by our own Zallet. The
oracle's fallback skips a self-hosted or private endpoint (plaintext, a docker name, a
private address), because our own indexer over our own node is not independent of
anything; the expiry-height read (transparent sender only) still asks every endpoint
and takes the highest answer. A public TLS name you run yourself would pass the filter:
do not build that shape.

## How a drip works

![One drip, end to end: the browser posts an address and proof-of-work, the faucet checks the cooldown, the fail-closed gate reads the node's height and shield recency, and only if safe does the send queue have Zallet build and sign the z2z transaction for Zebra to broadcast, returning a txid and explorer link.](faucet-flow.png)

A drip is a real z2z shielded transaction, so the amount, the recipient, and the link
back to the faucet stay off the public ledger. Transparent recipients still work and
are labeled public. Before anything is built, a fail-closed gate checks the node is
current enough to confirm the payment, and if it cannot prove that, the faucet refuses
rather than send a transaction that can never be mined. Sends run one at a time through
a FIFO queue, so two claims never spend the same notes.

## What it does

- **Shielded by default.** Every drip is z2z on the Ironwood pool.
- **Its own node and wallet.** Nothing that moves money depends on a third party.
- **Refuses payments that cannot confirm.** The tip is checked against an independent
  reference, and chain-identity and branch-id checks catch a forked or mis-upgraded
  chain rather than paying out on it.
- **Mines and auto-shields its funding.** A solo miner works `getblocktemplate`; a
  reserve loop shields matured coinbase into the wallet, sharing the send queue with
  drips and yielding the moment a real claim arrives.
- **Proof-of-work anti-abuse.** Browser-side PoW with adaptive, subnet-aware difficulty
  and single-use signed challenges. No captcha vendor. (`FAUCET_CHALLENGE` also allows
  `turnstile` or `none`.)
- **Privacy in the rate limiter.** Per-address cooldown and daily cap keyed on a salted
  hash of the IP. The raw address never reaches a log line.
- **Honest status.** Node, height, balance, miner, box integrity, refill and queue, all
  live off the node, on the page, no login.

## Why "refuses rather than guesses"

Owning the node removes the trusted third party. It does not by itself tell you the
node is *right*, so the faucet checks its own view rather than assuming it. Throughout,
a source that will not answer is recorded as **cannot verify**, never as a pass, because
a check that cannot run must not read the same as one that ran and found nothing wrong.

- **Freshness gates the money path.** Zcash transactions carry an expiry height set from
  the tip our node reports. A node lagging far enough builds transactions that are
  already expired when broadcast. The faucet compares its tip against an independent
  reference and refuses to build a payment when the gap is too wide. `node.shield` and
  `node.canBuildTx` on `/api/status` are that decision, kept separate from the looser
  "is the node broadly behind" signal on purpose: one is about availability, the other
  about money.
- **Ahead is not the same as agreeing.** A node in front of every reference is safe for
  an expiry height (ahead cannot be stale) but is not evidence of being on the same
  chain, and the status reason says so in those words.
- **Same rules.** The consensus branch id is compared against an independent source,
  which catches a missed network upgrade (`node.chain`).
- **Payouts are confirmed by somebody else.** Asking our own node whether our own
  transaction landed proves little, so confirmation goes to an independent source, and a
  payout past its expiry height is reported as permanently unmineable.

## Mining and the reserve loop

The solo miner works `getblocktemplate` against our own Zebra, and the reserve loop
(`src/lib/reserve/`) watches the spendable balance: below a low-water mark it shields
mined coinbase into the faucet's account, and it stops at a target, so the miner does
not flap. Refill work goes through the same serial send queue as drips and yields to a
waiting claim, so topping up never pauses service. Coinbase needs 100 confirmations to
mature, so a won block becomes spendable shielded balance about two hours later,
unattended.

On public testnet a single dominant miner takes most heights, so a small miner's blocks
are usually orphaned. Treat mining as a lottery ticket that occasionally pays rather than
a budget line; the measurement and the maths are in
[#42](https://github.com/jinolabs-xyz/zcash-faucet/issues/42). Donations fund the faucet,
mining supplements it. See [deploy/z3/MINING.md](../deploy/z3/MINING.md) and
[TESTNET-MINING.md](../TESTNET-MINING.md).

## How it is kept honest

Every merge is gated: typecheck, unit tests, route-level integration that boots the
built app and drives the claim flow end to end, shellcheck plus a harness over the
deploy scripts, and the miner's own `cargo test` and clippy. Nothing merges red.

The money path is tested adversarially, not just for a passing case. The send queue is
proven to serialize under a concurrent burst, a proof-of-work challenge is proven to
stay spent across a restart, and a send whose outcome cannot be observed is proven not
to hand out a second drip. More in [CONTRIBUTING.md](../CONTRIBUTING.md).
