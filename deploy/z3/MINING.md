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
| `MINER_THREADS` | `1` | 1 or 2, the CPU cap bounds it anyway |
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
