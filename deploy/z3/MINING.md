# Mining testnet blocks

> **Mining pays occasionally, at a rate we cannot yet estimate.** Nine wins so
> far, one of which survived and funded a real drip. At n=9 the survival rate
> could plausibly be anywhere from under 1% to nearly 50%, so do not plan
> around mining income in either direction. Fund the wallet from a source that
> does not race, and keep the miner running because it costs almost nothing and
> has demonstrably paid once. The reasoning, including the model this document
> got wrong first, is in
> [Why most of our blocks are orphaned](#why-most-of-our-blocks-are-orphaned-and-one-was-not-issues-32-69).

The intent was straightforward: the faucet pays out TAZ it has no other source
for, public testnet faucets are unreliable and rate-limited, so we mine our own.
The miner in [miner/](miner/) works public testnet blocks, and a coinbase that
survives pays the address zebra mines to. The machinery works. How often a
block survives is the open question.

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

**You should not normally need this.** `auto-deploy.sh` rebuilds and reinstalls the miner
whenever a commit touches `deploy/z3/miner/src/` or its `Cargo.toml`/`Cargo.lock` (#412).
Before that it did not, and the consequence was not subtle: the binary is compiled, so
`install-ops` could not refresh it, `box-report` correctly reported `minerBinary: stale`,
the box sat at 40 of 41, and the external probe was red for two days after #402 landed.

For a first install, or to recover by hand:

```bash
cd /opt/zcash-faucet/deploy/z3/miner
/root/.cargo/bin/cargo build --release      # builds the tromp solver too; cargo is NOT on
                                            # a non-login shell's PATH, and a plain `cargo`
                                            # here silently compiles nothing
# RENAME, never cp onto the running binary: `cp` gives "Text file busy", does nothing, and
# the restart then relaunches the OLD build while every status signal reads healthy.
install -m 755 target/release/zcash-testnet-miner /opt/faucet/.zcash-testnet-miner.new
mv -f /opt/faucet/.zcash-testnet-miner.new /opt/faucet/zcash-testnet-miner
cp ../zcash-testnet-miner.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now zcash-testnet-miner
sha256sum /opt/faucet/zcash-testnet-miner   # confirm the swap actually happened
journalctl -u zcash-testnet-miner -f
```

Roughly 41 seconds on the box, measured while cTAZ was mining at its 250% quota. That is
why this one is built in place while the Crosslink node is not: `SNAPSHOTS.md`'s
never-compile-on-the-box rule is about a build that takes hours and would starve the node
it serves. Shipping a 3 MB artefact instead would need a release asset or a registry -
a fetch path, a credential and a storage bill for something that rebuilds in under a
minute.

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

## Why most of our blocks are orphaned, and one was not (issues #32, #69)

Eight blocks in a row were orphaned. The ninth, height 4208641, survived and
funded a real drip. That single survivor overturned the explanation this
section used to give, so here is the corrected one and what was wrong.

**What the evidence says.** Block 4208642's `previousblockhash` is our
4208641, and 4208642's coinbase pays `tmFU5Ak...`, the miner that wins nearly
every height. So that miner **builds on our blocks**. They are a
much-larger honest miner, not an adversary ignoring our chain.

**What that means.** We lose most propagation races because they find blocks
far more often, and occasionally we win one and everyone builds on it. That is
ordinary orphaning, and survival is genuinely nonzero.

**The rate is not known.** One survivor in nine wins is 0.111, but at n=9 the
95% interval runs from roughly 0.003 to 0.48. That constrains almost nothing.
Do not plan funding on that number in either direction, and do not treat the
next orphan or the next survivor as news. What we can say: mining produces
spendable coinbase sometimes, at a rate we cannot yet estimate.

**Latency is worth measuring again.** In a propagation race, being late does
cost you the race, so template freshness and submit speed can matter here in a
way they would not against a miner ignoring us. The miner logs the three
numbers that decide it:

```bash
journalctl -u zcash-testnet-miner | grep -oE 'template_age [0-9]+s|solve_to_submit [0-9.]+s|solve [0-9.]+s'
```

Testnet targets 75 second blocks, so a 5 second poll and a sub-second submit
are still small fractions of the interval, and the honest position is that we
have no evidence latency is the binding constraint. But that is now a question
for the data rather than a settled conclusion.

**What follows.**

- **Keep the miner running.** One and a half capped cores, and it has produced
  real spendable funds. A lottery ticket with a demonstrated payout, not a
  budget line.
- **Fund from a source that does not race** for anything you are relying on.
  External testnet faucets, or an ask to the Zcash Foundation or ECC. TAZ has
  no market value, so asking is cheap and predictable in a way mining is not.
- **Collect more survivor data before optimising anything.** With n=9 no
  change we make can be shown to help. Revisit after a few dozen wins.

### What the earlier analysis got wrong

The previous version modelled this as gambler's ruin: if a dominant miner
never builds on our blocks, our chain only advances on our own blocks, and
below parity our blocks are orphaned with probability 1. The arithmetic was
right, verified by simulation, and it is preserved in the #42 discussion.

The premise was wrong. "Never builds on ours" was inferred from that miner
winning every height, which is much weaker evidence than it was treated as,
and one survivor falsified it. The correct model gives a different answer and
a different recommendation, most sharply on latency: the old text said not to
spend effort there because the ceiling was zero, and under propagation racing
that reasoning does not hold.

Worth recording because the failure mode was not sloppy maths, it was rigorous
maths resting on an untested assumption, which is more persuasive and therefore
more dangerous. The check that settled it cost one RPC call: read the next
block's parent hash.

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
