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
their sample files. Generate instead:

```sh
ctaz-zebrad generate -o /etc/faucet/ctaz-zebrad.toml
```

That emits `crosslink_default()`: ClT0 magic, genesis `05a60a92…`, and four bootstrap peers
compiled into the binary. There is no DNS seed and no seeder behind them.

Then change **only**:

- `[network] listen_addr` — your chosen base (see above)
- `[rpc] listen_addr` — must be `base - 1`; zaino assumes it
- `[state] cache_dir` — `/var/lib/ctaz-node`
- `[mining] internal_miner` — leave `false` unless funding says otherwise
- **`[crosslink] bft_peers`** — see the trap below

### The `bft_peers` trap

**Omitting `bft_peers` does not give you an isolated node.** It inherits
`crosslink_default()`'s four BFT peers, and the node joins their consensus layer. A
"private" regtest node here did exactly that on the first attempt — the giveaway was
`Connected to new server` and `BFT_UPDATE` in a log that should have been silent.

Set it explicitly, always. To verify isolation, check the connections **for that PID**:

```sh
lsof -nP -iTCP -a -p "$(pgrep -f ctaz-zebrad)" | grep -v LISTEN
```

Config-says-isolated and is-isolated are different claims.

## Disk, which is the open risk

Measured growth on their chain, syncing from genesis:

| height | on disk | KB/block |
|---|---|---|
| 428 | 8.7 M | 20.8 |
| 1,648 | 48 M | 29.8 |
| 22,193 | 1.4 G | 66.1 |
| 36,676 | 2.8 G | 80.1 |

**Per-block cost rises with height**, so every extrapolation from an early prefix
understates. Successive estimates went 7.4 GB → 10.6 → 23.5 → **28.5 GB**, against ~28 GB
free on the box. Treat the final figure as **UNKNOWN until a node reaches the tip**, and do
not plan against any of those numbers.

`ctaz-datadir-guard.sh` refuses to *start* a node whose state already exceeds
`CTAZ_MAX_STATE_GB`. **It is not a quota** — nothing stops a running node growing. A real
ceiling needs a filesystem quota or a dedicated volume, and that is still open.

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
