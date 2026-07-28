# Mining testnet blocks to fund the faucet

The faucet pays out TAZ it does not otherwise have a source for. Public
testnet faucets are unreliable and rate-limited, so we mine our own: the
miner in [miner/](miner/) wins public testnet blocks, the coinbase pays the
address zebra is configured to mine to, and that balance is what the faucet
drips.

## Why a CPU is enough (and only on testnet)

Zcash testnet has a minimum-difficulty rule: when blocks are spaced far
enough apart, the target drops to the network floor. At the floor, a single
core finds a block in a reasonable time. Our node currently reports `bits`
of `1f2f93c0`, which expands to an enormous target, i.e. very low difficulty.
On mainnet this approach is pointless and the miner should never be pointed
there.

## How it works

One loop, no cleverness:

1. `getblocktemplate` with `mode=template`.
2. Lay out the 108-byte header prefix from the template: version, previous
   block hash, `defaultroots.merkleroot`, `defaultroots.blockcommitmentshash`,
   `curtime`, `bits`.
3. Run tromp's Equihash 200,9 solver over nonces.
4. Double-SHA256 the serialized header and compare against the target
   expanded from `bits`.
5. Validate the assembled block with `getblocktemplate mode=proposal`.
6. `submitblock` (only in submit mode).

Two deliberate choices:

**The solver is not ours.** It comes from librustzcash's `equihash` crate
with the `solver` feature, which wraps tromp's C solver. That is the same
crate and entry point zebra's own internal miner uses. Nobody should
hand-roll proof of work.

**The coinbase is not ours either.** Zebra builds `coinbasetxn` (paying
`ZEBRA_MINING__MINER_ADDRESS`) and computes the commitment roots. The miner
copies those bytes verbatim and never constructs a transaction. Fewer places
to get consensus wrong.

A note on the solver input, because it is the easy mistake: `solve_200_9`
takes the *partial* input (the 108-byte prefix) and appends the nonce itself.
Passing prefix+nonce hashes 32 bytes too many and yields solutions that look
fine locally and fail consensus. `cargo test --release -- --ignored
solved_solution_verifies` runs a real solve and checks the result with
`equihash::is_valid_solution`, which is what catches that class of bug.

## Modes

`MINER_MODE=proposal` (the default, and what the service ships with) solves
and then validates through `getblocktemplate mode=proposal`. Zebra runs its
full block check and returns `null` for a valid block, and **nothing is
submitted**. This is the acceptance gate: it proves the block would be
accepted without touching the chain.

`MINER_MODE=submit` does the same and then calls `submitblock`. Flip it only
after a proposal-mode run reports `proposal VALID`, and coordinate the first
live submission.

## Build and install

```bash
cd /opt/zcash-faucet/deploy/z3/miner
cargo build --release                       # builds the tromp solver too
cp target/release/zcash-testnet-miner /opt/faucet/
cp ../zcash-testnet-miner.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now zcash-testnet-miner
journalctl -u zcash-testnet-miner -f
```

Config in `/etc/faucet/miner.env`:

| Variable | Default | Notes |
|---|---|---|
| `MINER_MODE` | `proposal` | `submit` goes live |
| `MINER_RPC_URL` | `http://127.0.0.1:18232` | `http://zebra:18232` from inside the docker network |
| `MINER_COOKIE_PATH` | `/var/run/auth/.cookie` | from the `z3-testnet-cookie` volume |
| `MINER_THREADS` | `1` | 1..=4. `CPUQuota=150%` makes past 2 pointless, and the ceiling is what `MemoryMax=1G` affords at ~144 MB per thread |
| `MINER_TEMPLATE_SECS` | `60` | refetch the template after this long |
| `MINER_POLL_SECS` | `5` | backoff after an RPC error |

Reaching the cookie from the host: the file lives in the
`z3-testnet-cookie` volume, so either point `MINER_COOKIE_PATH` at that
volume's mountpoint (`docker volume inspect -f '{{.Mountpoint}}'
z3-testnet-cookie` plus `/.cookie`) or run the miner with the volume
mounted. Zebra also accepts unauthenticated calls when
`ZEBRA_RPC__ENABLE_COOKIE_AUTH=false`, in which case the miner works with no
cookie and says so on startup.

## Resource caps

The unit pins `CPUQuota=150%`, `Nice=15`, `IOSchedulingClass=idle` and
`MemoryMax=1G`. The node and the wallet must always win: a starved zebra
costs us the faucet, while a slow miner costs us nothing but time. This is
also why the miner is a separate process rather than zebra's built-in
`internal_miner`, which cannot be capped independently of the node.

## Why our blocks were orphaned (issue #32)

All eight blocks we mined were orphaned. Every height was won by one miner
(`tmFU5Ak...`) that extends only its own chain and never builds on ours. It is
worth being precise about what that means, because the intuitive fix is the
wrong one.

**It is not latency.** The miner now logs three numbers on every block:
template fetch time, `template_age` (how stale the parent was when we had a
solution), and `solve_to_submit` (having a winning block to the network
hearing about it). Read them out of the journal:

```bash
journalctl -u zcash-testnet-miner | grep -oE 'template_age [0-9]+s|solve_to_submit [0-9.]+s|solve [0-9.]+s'
```

Testnet targets a 75 second block interval. A 5 second template poll and a
sub-second submit are single-digit percentages of that, so shaving them
changes a race we are losing by a wide margin. If `template_age` ever comes
back in the tens of seconds, that is worth fixing, and the numbers are now
there to check rather than assume.

**It is hashrate share, and the consensus rule does the rest.** A miner that
ignores our blocks means our chain only ever advances when *we* find a block,
while theirs advances when *they* do. That is a biased random walk, and with
share `q` below theirs the outcome is not close:

| Our share `q` | We win one race | Three in a row | Long-run survival |
|---|---|---|---|
| 2% | 0.02 | 0.000008 | 0 |
| 10% | 0.10 | 0.001 | 0 |
| 33% | 0.33 | 0.036 | 0 |
| 50% | 0.50 | 0.125 | 1 |

Below 50% of the hashrate that miner brings, long-run survival of any given
block is zero, not merely low. Eight orphans out of eight is exactly the
expected result, not bad luck. Our own share is a single CPU capped at 150%
of one box against a miner winning every height, so `q` is very small.

**What follows.** Mining cannot fund the faucet while that miner is active.
Not "funds it slowly", cannot: expected revenue is `q^k`-shaped and rounds to
zero. So:

- **Keep the miner running.** It costs one and a half capped cores, it lands
  a block whenever the dominant miner pauses or a min-difficulty gap favours
  us, and those coinbases are real when they survive. It is a lottery ticket,
  not a budget line.
- **Do not spend effort on latency.** Template freshness, faster submits and
  more solver threads all multiply a number whose ceiling is set by hashrate
  share. The measurement exists so this stays a decision rather than an
  argument.
- **Fund the faucet from a source that does not race.** External testnet
  faucets, an ask to the Zcash Foundation or ECC for testnet TAZ, or an
  existing testnet balance. This is a testnet faucet, TAZ has no market
  value, and asking is cheap and reliable in a way that out-mining a
  dominant miner is not.
- **Revisit if the picture changes.** If that miner goes quiet for a stretch,
  our survival rate stops being zero and mining becomes worth counting again.
  `journalctl -u zcash-testnet-miner | grep ACCEPTED` is the check.

The honest summary: the miner is correct, it is winning solves and losing
races, and no amount of tuning on our side changes that while one participant
holds the majority of testnet hashrate and refuses to build on anyone else.

## Operating notes

- Blocks pay to `ZEBRA_MINING__MINER_ADDRESS` on the node, not to anything
  configured here. Changing the payout address is a node config change.
- Mined coinbase needs 100 confirmations before it is spendable, so expect a
  lag between winning a block and the faucet balance moving.
- The coinbase is transparent. Getting it into the shielded faucet account
  is the shielding step (`z_shieldcoinbase`), which is the reserve/refill
  work, not this.
- "no solution in this window" in the log is normal: it means the template
  aged out before a solution landed, and a fresh template was fetched.
