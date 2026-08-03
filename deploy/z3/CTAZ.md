# The Crosslink (cTAZ) node on our box

Operator notes for `ctaz-node.service`. Everything here was observed by running their
software, not read off a README — where a number is still a guess, it says so.

The background investigation is on the `spike/crosslink-headless` branch
(`docs/spikes/crosslink-headless.md`). This file is only what you need to run the thing.

## What it is

A single `zebrad` binary built from `ShieldedLabs/crosslink_monolith`, joined to their
Crosslink Testnet 0 feature net. One process contains three things:

- the node
- **a wallet**, spawned unless `crosslink.disable_the_headless_wallet` is set
- **zaino**, their lightwalletd-compatible indexer, spawned unless `crosslink.disable_zaino`
  is set

That is not a deployment we invented. `viz_gui` is an opt-in cargo feature that is *not* in
`default`, and the `#[cfg(not(feature = "viz_gui"))]` branch of their start command is the
one that spawns the wallet. Headless is their default; the GUI is the special case.

## Ports: pick the base, and you have picked four

Every listener derives from **one** config value, `network.listen_addr`. With `P` as the
P2P port:

| | port | binds |
|---|---|---|
| zebrad JSON-RPC | `P - 1` | loopback |
| P2P | `P` | |
| zaino JSON-RPC | `P + 10000` | `127.0.0.1` |
| zaino gRPC | `P + 10001` | **`0.0.0.0` as shipped** |

Two of those are ten thousand ports from the number you type, so **never choose a base by
eye**:

```sh
/opt/faucet/ctaz-port-check.sh <base>      # checks all four
/opt/faucet/ctaz-port-check.sh --suggest   # returns a base whose whole family is clear
```

The unit runs this as `ExecStartPre` and refuses to start on a collision. The case that
motivates it: their default base `8233` puts zaino's JSON-RPC on `18233`, **our zebra P2P
port** — and `audit-access.sh` would not flag it, because `18233` is already on its
allowed-public list.

The gRPC listener binding `0.0.0.0` is theirs, not ours, and it is not configurable from
the config file. Until that is patched, the firewall is the only control.

## Joining the network

**Do not copy the `.toml` files in their repo.** They do not load against their own current
code — `do_not_manipulate_config` and `[crosslink] listen_address` are no longer valid
fields — and both committed configs use a network magic (`ClRn`, `ClTn`) that the binary
has no genesis for, so it panics with `unhandled special-case genesis`.

The only magic with a genesis is **`ClT0`** (`[67,108,84,48]`), and it appears in none of
their sample files. Run `ctaz-config.sh`, which generates with the pinned binary and applies
our deltas on top:

```sh
/opt/faucet/ctaz-config.sh /etc/faucet/ctaz-zebrad.toml
```

`generate` emits `crosslink_default()`: ClT0 magic, genesis `05a60a92…`, NU6 at height 1,
funding streams, ten lockbox disbursements, a trusted checkpoint, and four bootstrap peers
compiled into the binary. There is no DNS seed and no seeder behind them.

**Hand-writing this config does not work, and the failure is not obvious.** `network =
"Testnet"` without the `[network.testnet_parameters]` block is the *real* Zcash testnet, and
their node aborts on it with `unhandled special-case genesis` (`start.rs:428`). The network
parameters are not decoration around the keys you care about.

The script changes only these, and prints the diff against their default every run:

| key | value | why |
|---|---|---|
| `[network] listen_addr` | `[::]:19233` | our chosen base |
| `[rpc] listen_addr` | `127.0.0.1:19232` | must be `base - 1`; zaino derives it |
| `[rpc] cookie_dir` | `/mnt/ctaz-chain/node` | default is `/root/.cache/zebra`, unwritable as `ctaz` |
| `[rpc] enable_cookie_auth` | `false` | their shipped value; see below |
| `[state] cache_dir` | `/mnt/ctaz-chain/node` | the dedicated volume |
| `[mining] internal_miner` | `false` | until synced; see below |

`[crosslink] bft_peers` is left exactly as generated — see the trap below.

**Cookie auth stays off, which is not the instinct.** Turning it on kills the node: their
zaino runs in-process, fails with `correct authorisation details have been entered`, and
takes zebrad down about nine seconds after start. Their embedded indexer is built against
the no-cookie path. The exposure is bounded — the RPC is loopback-only and our containers
are bridged, so they cannot reach the host's loopback; what can reach it is any process on
the host itself. Acceptable for a feature-net node, and the reason the TAZ wallet is not
configured this way.

### Turning the miner on

Two changes, and they are deliberately coupled so neither is forgotten alone. Do them
**only once the node is at their tip** (`sync_percent` at 100%, `remaining_sync_blocks` ~0):

```sh
sed -i 's/^internal_miner = false/internal_miner = true/' /etc/faucet/ctaz-zebrad.toml
rm /etc/systemd/system/ctaz-node.service.d/10-initial-sync.conf
systemctl daemon-reload && systemctl restart ctaz-node
```

The drop-in raises `CPUQuota` to 200% for the sync, which is CPU-bound. Dropping it back to
100% at the same moment matters: a miner uses every bit of quota it is given, forever, and
past this point cTAZ mining competes with TAZ mining for a 4-core box. TAZ is what funds
the faucet people actually use.

A node with no peers believes it is at the tip, so leaving the miner on for a fresh sync
mines a fork of genesis within seconds — measured: four blocks before the first peer
handshake completed. Those blocks are orphaned when the real chain arrives, so the cost is
wasted CPU, not a wrong chain.

### The `bft_peers` trap

**Omitting `bft_peers` does not give you an isolated node.** It inherits
`crosslink_default()`'s four BFT peers, and the node joins their consensus layer. A
"private" regtest node here did exactly that on the first attempt — the giveaway was
`Connected to new server` and `BFT_UPDATE` in a log that should have been silent.

**The production node keeps their four peers, which reverses the spike's advice, because
the goal reversed.** The spike wanted an isolated node and got an accidental participant.
This node is a deliberate participant: it exists to serve the real cTAZ chain, so it has to
follow their finality layer. Connecting to BFT peers is how a node *learns* finality; it
does not make it a validator, which needs a registered key we do not have and have not
asked for.

What matters either way is that the value is *stated*. Isolated means `bft_peers = []`
written down, never the key left out.

To check what a node is actually connected to, look at the connections **for that PID**:

```sh
lsof -nP -iTCP -a -p "$(pgrep -f ctaz-zebrad)" | grep -v LISTEN
```

Config-says-isolated and is-isolated are different claims.

## Disk: a dedicated volume, and why the pathing is the way it is

The chain state lives on its own block device, **not** on the disk that runs the faucet:

| | |
|---|---|
| device | `/dev/sdc`, 59 GB ext4 |
| mount | `/mnt/ctaz-chain`, `nofail` in fstab |
| datadir | `/mnt/ctaz-chain/node`, owned by the `ctaz` system user |
| alias | `/var/lib/ctaz-node` is a symlink there for humans; nothing depends on it |

`nofail` matters: without it a detached volume stops the **box** from booting, which would
turn a best-effort feature net into a total outage.

The trap on the other side is that a detached volume leaves `/mnt/ctaz-chain` as a
perfectly good empty directory on the root disk, so a node pointed at it would start and
sync the entire chain onto the disk it was moved off to protect. `RequiresMountsFor=` in
the unit is what closes that: no mount, no start. A full root disk is what took the faucet
down on 2026-08-03, so this is a repeat, not a hypothetical.

`ProtectSystem=strict` mounts everything read-only, `/mnt` included, so the unit punches
the datadir back through with `ReadWritePaths=`. Without it the node starts and fails on
its first write, which reads like a bad volume rather than a config choice.

## How big it gets, which is still unknown

Measured growth on their chain, syncing from genesis:

| height | on disk | KB/block |
|---|---|---|
| 428 | 8.7 M | 20.8 |
| 1,648 | 48 M | 29.8 |
| 22,193 | 1.4 G | 66.1 |
| 36,676 | 2.8 G | 80.1 |

**Per-block cost rises with height**, so every extrapolation from an early prefix
understates. Successive estimates went 7.4 GB, then 10.6, then 23.5, then **28.5 GB**.
Treat the final figure as **UNKNOWN until a node reaches the tip**, and do not plan
against any of those numbers. The 59 GB volume was sized against the largest of them with
room for the estimate to keep climbing, which on this chain it has done every time.

`ctaz-datadir-guard.sh` refuses to *start* a node whose state already exceeds
`CTAZ_MAX_STATE_GB` (45 GB in `ctaz.env`, deliberately under the volume). **It is not a
quota** — nothing stops a running node growing. The volume is what makes that survivable;
the guard is the early warning, not the ceiling.

Note the indexer's database lives **inside the same tree**, at `<chain-name>/zaino/local`,
so the state directory is not purely chain state.

## Syncing: do it off the box

Initial sync measured ~114 blocks/min, so roughly **54 hours from genesis**. Sync
elsewhere and ship the directory; the box does catch-up only.

**`zsnap` cannot do this for you.** Their layout is
`<cache_dir>/<chain-name>/state/v27/unknowntestnet` — an extra chain-name level, and a
network directory named `unknowntestnet` — so `zsnap`'s probe finds nothing and its
preflight ends `NO-GO`. That is the correct outcome and it fails safely, but it means
shipping the raw directory is a separate job. `zsnap` stays TAZ-only.

## Things it will do that look broken and are not

- `WAITING 10 SECONDS BECAUSE ZAINO WILL CRASH IF IT DOES STUFF BEFORE ZEBRA` — theirs, in
  capitals, on every start. zaino runs *in-process*, so no systemd ordering can remove it.
- `Deferring: … not resolvable yet` in bursts during catch-up.
- `errors: "configure an indexer_listen_addr…"` in `getinfo` when zaino is disabled.

## Not done yet

- **No alert tiering.** The unit wires `OnFailure=faucet-alert@%n.service` like every other
  service, so a cTAZ failure currently **pages exactly like a TAZ outage**. `alert.sh` has
  no severity concept. Omitting the handler was tried and rejected: it buys silence, not
  quiet.
- **Not enabled.** Installed so the box spec counts it; enabling is a separate decision.
- **No containerized build yet.** It must be built for `x86_64` off the box and shipped as
  a binary; nothing this large should compile beside a live faucet.
- **No observed drip.** Nothing user-facing ships until one is seen — their
  `requestfaucetdonation` pays from *the node's own mining wallet*, so an unfunded node
  accepts the request and moves nothing.
