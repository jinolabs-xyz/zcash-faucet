> **Landed 2026-08-04 as a historical record, unedited below this line.** It was written as
> a source read with "nothing here lands in `main`" at the top; that was true on 2026-08-02
> and is why it stayed on a branch. Issue #322 cites it as the plan's evidence base, so it
> is in the tree now rather than on a branch that branch cleanup would delete.
>
> **Read it as of its own date.** Three of its numbers have since been settled by running the
> thing, and the doc is deliberately NOT edited to match, because the gap between what a
> careful source read predicted and what the node did is the useful part:
>
> | the spike said | what happened |
> |---|---|
> | disk `~7.4 GB` floor, `8-12 GB` realistic | **2.2 GB at tip.** Mid-sync readings measure uncompacted RocksDB files and overstate settled size by roughly 10x, so no prefix predicts the total. See `deploy/z3/CTAZ.md`. |
> | "the tree says yes, not it works" | the node has run on the box since 2026-08-03 17:36 UTC: at tip, mining, serving the panel |
> | `requestfaucetdonation` accepts a shielded address | still the only unproven half - accepting a request is not sending money, and no drip has been observed. That is #328, and it is what still gates #322. |

---

# Crosslink: can we run a faucet on the feature net without a GUI?

One-day spike. 2026-08-02. SDE-Infra.

**Status of the evidence: this is a source read, not a running node.** Nothing here was built
and nothing was run. Every claim below points at a file and a line you can check in a minute,
and each section ends with the one command that would upgrade it from "the code says so" to
"I watched it happen". I am flagging this hard because the whole verification programme we
just shipped exists because somebody read a config and reported a fact. Read this as
*"the tree says yes and here is where"*, not *"it works"*.

**Scope note:** the production box was not involved in any way — not built on, not tested
against, not queried. This was a read of a local clone. Nothing here lands in `main`.

---

## Bottom line

The brief braced for a clean "no, here is what is missing". The answer is **yes on all three
real questions**, and the reason is better than luck: they already built the headless case
on purpose.

The single most load-bearing fact in this document:

```rust
// zebra-crosslink/zebrad/src/commands/start.rs:121
#[cfg(not(feature = "viz_gui"))]
{
    if config.crosslink.disable_the_headless_wallet == false {
        let wallet_state = Arc::new(std::sync::Mutex::new(wallet::WalletState::new()));
        tokio::spawn(zebra_crosslink::wallet::wallet_main(wallet_state));
    }
}
```

Three things at once, and all three are what we want:

1. `viz_gui` is a **cfg the GUI build turns on**, so this branch is the *default* build.
2. There is a config key literally named `disable_the_headless_wallet`, and it
   **defaults to `false`** (`zebra-crosslink/zebra-crosslink/src/lib.rs:136,156`). A headless
   wallet is not something we would be bolting on. It is the default mode and they named it.
3. The headless path spawns the **wallet**, not just the node.

So the shape we would deploy is a supported configuration of their software, not a fork.

---

## Q1 — Does the node run without a window?

**Yes.** Evidence, in descending order of strength:

| What | Where |
|---|---|
| `viz_gui` is opt-in, absent from `default` | `zebrad/Cargo.toml`: `default = ["default-release-binaries", "internal-miner"]` |
| GUI is a separate feature that pulls a separate crate | `viz_gui = ["zebra-crosslink/viz_gui"]` |
| The headless branch is `cfg(not(viz_gui))` | `zebrad/src/commands/start.rs:121` |
| A config key exists to *disable* the headless wallet | `zebra-crosslink/src/lib.rs:136` |
| Dependency direction | `zebra-gui` depends on `wallet`. Nothing depends on `zebra-gui`. |
| The wallet crate has zero GUI toolkit deps | no `egui`/`eframe`/`winit`/`wgpu` anywhere in `wallet/Cargo.toml` |

The `zebrad` binary target declares no GUI dependencies. The GUI is a consumer of this tree,
not a component of it.

> **To upgrade this claim:** `cargo build --release -p zebrad` in the clone, then
> `./zebrad start` with a throwaway config and confirm it stays up with `$DISPLAY` unset.
> That is the whole proof and it costs one build.

---

## Q2 — What JSON-RPC surface survives, and what serves `get_tfl_recency_status`?

**The full zebrad surface survives, plus Crosslink's own.** 50 methods, all declared in one
file: `zebra-crosslink/zebra-rpc/src/methods.rs`.

`get_tfl_recency_status` is served by **zebrad itself** — it is method 22 in that file, in the
same trait as `getblockchaininfo`. It is not a GUI feature and not a separate service. That
answers the question as asked: the thing we would need for a readiness gate on their network
is exposed by the same daemon on the same port as everything else.

What matters to us, grouped:

**Our faucet's existing model ports directly**
- `sendrawtransaction` — broadcast. This is the one that decides everything, and it is there.
- `getblockchaininfo`, `getbestblockheightandhash`, `getblockcount`, `getbestblockhash` — tip
- `getrawtransaction` — confirmation tracking
- `getrawmempool`, `validateaddress`, `z_validateaddress`, `z_listunifiedreceivers`

**Crosslink-specific, no analogue on our current stack**
- `get_tfl_recency_status` — *the* readiness primitive, and it is a better one than we have.
  Our `node.shield` gate infers freshness by comparing our tip to an independent source. This
  answers it directly.
- `is_tfl_activated`, `get_tfl_final_block_hash`, `get_tfl_final_block_height_and_hash`,
  `get_tfl_block_finality_from_hash`, `get_tfl_tx_finality_from_hash`
- `stream_tfl_new_final_block_hash`, `stream_tfl_new_final_txs`,
  `notify_tfl_block_becomes_final_by_hash`, `notify_tfl_tx_becomes_final_by_hash` — push, not
  poll. Our watchdog polls.
- `get_tfl_roster_zec` / `_zats`, `staking_command`, `wallet_staking_action`, `getbondinfo`,
  `get_tfl_fat_pointer_to_bft_chain_tip` — the PoS side
- `set_tfl_finality_by_hash` — worth noting this exists and is presumably test-only

**Lightwalletd-shaped**
- `z_gettreestate`, `z_getsubtreesbyindex` — exactly what an indexer needs to serve clients

**Mining** — `getblocktemplate`, `submitblock`, `getmininginfo`, `generate`, `getnetworksolps`

**Their own faucet RPC** — `requestfaucetdonation`, see below.

> **To upgrade this claim:** with the node from Q1 running,
> `curl -s -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"get_tfl_recency_status","params":[]}' http://127.0.0.1:<rpcport>`
> and the same for `getblockchaininfo`. Declared-in-source and served-at-runtime are not the
> same claim, and only one of them is a phone jack.

---

## Q3 — Can an existing Zingo talk to their network?

**The pieces are all in the tree, and the wallet crate is a lightwalletd client.**

`wallet/Cargo.toml` has no GUI toolkit and does have `tonic`, `prost`, `tokio-rustls`,
`zcash_client_backend`, `zcash_client_sqlite`, `zcash_proofs` (bundled prover). That is a gRPC
lightwalletd client with local proving — the same architecture our sender uses. It exposes
`send_to_address(address, amount)`, `send_zats`, and `send_orchard_to_orchard_zats`.

`zingo-lib/zingo-cli` is in the tree with a `send` command
(`zingo-cli/src/commands.rs:2041`), and so are `zaino`/`zainod`, which is the lightwalletd-
compatible indexer. So the full path — client → indexer → node — exists in-tree rather than
needing to be assembled.

**The find I did not expect:** they ship a faucet. `requestfaucetdonation` is a real RPC, and
it dispatches to a closure registered at `wallet/src/lib.rs:3186` inside `wallet_main` — the
same `wallet_main` the headless branch spawns. It decodes a unified address, **requires an
Orchard receiver**, and pushes onto a bounded `FAUCET_Q`. If nothing registered the closure it
returns `"No faucet available"`.

Two consequences worth separating:

- *Encouraging:* a headless zebrad on their net comes up already able to answer faucet
  requests, and the shielded-only posture is theirs too, not just ours.
- *Careful:* that also means **we may not be the interesting contribution on their net**. What
  we have that their built-in does not is the operational layer — the rate limiting, the abuse
  handling, the readiness gate, the backups, the verification. Worth being honest about that
  in whatever we propose, rather than pitching a faucet at people who have one.

> **To upgrade this claim:** this is the weakest section and I want to say so plainly. I have
> shown the *parts* exist. I have **not** shown that `zingo-cli` will sync against the feature
> net — that depends on their consensus branch ID and network parameters matching what the
> client expects, which a source read cannot settle. The test is: point `zingo-cli` at a
> `zainod` in front of the Q1 node on a throwaway seed, and see whether it syncs and sends.
> Until someone does that, Q3 is "very likely" and not "yes".

---

## Q4 — Estimate for a minimal headless wallet service

The brief said to do this only if 1–3 came back empty. They did not, so this is a **fallback
estimate, not a recommendation** — the recommendation is to use the headless mode they
already ship.

If Q3's sync test fails and we needed our own service around their wallet crate: the crate is
already GUI-free and already exposes send, so the work is a service wrapper — config, key
handling, an HTTP surface, and the same operational layer we have. **Roughly 3–5 days** to
something that sends, plus the porting of our existing gates. The estimate is low precisely
because `wallet/` is usable as a library today; if that stops being true the number is not
5 days, it is a rewrite, and I would want to re-scope rather than defend this figure.

---

## What I would do next, in order

1. **Build `zebrad` headless and start it.** One command, settles Q1 from "source says" to
   "observed", and gives Q2 something to curl.
2. **Curl `get_tfl_recency_status` and `sendrawtransaction`'s presence.** Cheap, and turns the
   most load-bearing claim in this document into an observation.
3. **The Q3 sync test.** `zainod` + `zingo-cli` + throwaway seed. This is the one that decides
   whether our faucet ports, and it is the only remaining real unknown.

Steps 1–2 are a couple of hours. Step 3 is the rest of the day and is where the risk lives.

## What this spike does not tell you

- Whether any of it **runs**. Nothing was built or executed.
- Whether the feature net is **reachable** or has peers, or where its seeds are.
- Whether their consensus parameters accept a transaction built by a stock Zingo.
- Anything about **funding** — where testnet value on that net comes from, and whether
  `requestfaucetdonation` on someone else's node is the intended source.
- Anything about the production box, which was deliberately not touched.

---

# Second pass: the same-box question

Added after the CTO authorized steps 1–3 and the owner asked whether this could ship **on the
faucet box** as a TAZ/cTAZ toggle. Same evidence rules as above: everything in this section is
still a **source-and-config read**. The build was running while this was written and no port
below has been curled yet.

## The CTO's catch, verified

`disable_zaino` defaults to `false` (`zebra-crosslink/src/lib.rs:138` declared, `:157`
defaulted) and is consumed at `zebrad/src/commands/start.rs:658` — inside the **same**
`#[cfg(not(feature = "viz_gui"))]` block as the wallet. So the headless binary embeds the
indexer as well as the wallet. That is our Zallet architecture: the client does not have to
find a lightwalletd, because the node *is* one. It substantially reduces the Q3 risk I flagged
in the first pass.

## There are two different Crosslink networks in this repo, and only one is a network

This is the thing that most changes the picture, and I had it wrong by omission in the first
pass.

| config | `network_magic` | means | peers |
|---|---|---|---|
| `testnet_1.toml`, `testnet_2.toml` | `[67,108,82,110]` = **ClRn** | Crosslink *Regestnet* | all loopback — a private two-node net you stand up yourself |
| `sam_mac_multiplayer_config_0/1.toml` | `[67,108,84,110]` = **ClTn** | Crosslink *Testnet* | stock Zcash seeds **commented out**, replaced with `70.34.201.202:8233` and `45.76.30.90:8233` |

So a real feature net does appear to exist, and its entire published bootstrap is those two
hardcoded IPs. There is no DNS seed and no seeder in this tree. That is worth saying plainly
before anyone plans around it: joining is two IP literals in a config, and if those two hosts
go away there is no discovery mechanism behind them.

Both networks set `network = "Testnet"` with a **custom magic**, so neither will talk to
public Zcash testnet, and a stock client pointed at them will not connect.

## The port map, and why the collision is not where we expected

Every port derives from **one** knob, `config.network.listen_addr`
(`zebrad/src/commands/start.rs:664-682`). With `P` = the P2P port:

| service | port | binds |
|---|---|---|
| zebrad JSON-RPC | `P - 1` | loopback |
| zaino JSON-RPC | `P + 10000` | `127.0.0.1` |
| zaino gRPC (lightwalletd) | `P + 10001` | **`0.0.0.0`** |

Their shipped ClTn config confirms the `P-1` convention rather than leaving it inferred:
`listen_addr = "0.0.0.0:8233"` with `[rpc] listen_addr = '127.0.0.1:8232'`.

Now against our own box. From `deploy/deploy.sh:56-57` and `deploy/z3/audit-access.sh:9`, a
**testnet** box is: zebra RPC `127.0.0.1:18232`, health `127.0.0.1:18080`, zebra P2P `18233`
public, Zallet RPC `127.0.0.1:40232`.

| crosslink service | port | vs our testnet box |
|---|---|---|
| zebrad RPC | `8232` | **free.** Our testnet RPC is `18232` |
| zebrad P2P | `8233` | free, but already whitelisted by `audit-access.sh` |
| zaino JSON-RPC | `18233` | **COLLIDES with our zebra P2P** |
| zaino gRPC | `18234` | free, but binds `0.0.0.0` |

**The 8232 collision the question assumed does not exist on a testnet box** — that is the
mainnet numbering. The real collision is zaino's JSON-RPC landing on `18233`, which is our
zebra P2P port, and it arrives via the `+10000` formula rather than from anything you would
see reading their config. It is also the collision `audit-access.sh` would *not* flag, because
`18233` is on its allowed-public list already.

All of it moves together by changing one base port, so this is a config exercise, not a patch.
Any candidate base `P` has to be checked at four places at once: `P-1`, `P`, `P+10000`,
`P+10001`.

## Two things I would not inherit as defaults

1. **The zaino gRPC listener binds `0.0.0.0`**, unlike the other two, which are loopback. On
   our box that is a publicly reachable indexer unless the firewall says otherwise. A
   deliberate decision, not a default to accept quietly.
2. **zaino is handed `Network::Regtest` with every activation height forced to `1`,
   hardcoded, regardless of the actual network**, and `validator_user`/`validator_password`
   hardcoded to `"xxxxxx"` (`start.rs:672-706`). That reads as feature-net scaffolding, not as
   something to run beside a live faucet, and right now it is the strongest argument against
   same-box that I have found.

## Disk

Partial, and honestly labelled as such. zaino's own database is capped **in code** at
`DatabaseSize::Gb(4)` (`start.rs:700`) and lives at `state.cache_dir/zaino`, so it *shares*
the box's 28G with zebra's chain state rather than sitting beside it. The 4G cap is a floor to
subtract, not the answer. The measured chain-state figure needs a sync and is not in this
document yet.

---

# Third pass: observed

The CTO authorized steps 1–3. Everything in this section was **run**, not read. Where a claim
is still inference, it says so in the sentence that makes it.

## Step 1 — it runs without a window. Observed.

```
cargo build --release -p zebrad     # DEFAULT features. viz_gui not enabled.
Finished `release` profile in 6m07s
88M  target/release/zebrad          # zebrad 2.5.0
```

`otool -L` on the binary lists exactly four libraries: `CoreFoundation`, `libSystem.B.dylib`,
`libc++.1.dylib`, `libiconv.2.dylib`. **Zero** GUI frameworks — no AppKit, Cocoa, Metal,
QuartzCore, OpenGL. That is the real evidence; on macOS an unset `DISPLAY` proves nothing
because the GUI stack is not X11.

## Step 2 — the RPC surface, on a node joined to the live feature net. Observed.

The node connected to their network and reported `connections: 4`, then 5. The log printed
`activating TFL!`. Curled results, trimmed:

| method | result |
|---|---|
| `get_tfl_recency_status` | real data: `now_utc`, `my_height`, `my_round`, `my_locked_round`, `finalizer_statuses` with per-finalizer vote counts |
| `is_tfl_activated` | `true` |
| `get_tfl_final_block_height_and_hash` | height + hash |
| `get_tfl_roster_zats` | live validator roster, `pub_key` + `voting_power` |
| `getpeerinfo` | 5 real peers, their four seeds plus one |
| `get_wallet_ufvk` | a real `uviewtest1…` key |

That last row is the one that matters for us: **the headless wallet started, generated keys,
and served them over JSON-RPC with no GUI anywhere in the process.** The first pass called Q3
"very likely"; this is the part of it that is now settled.

`requestfaucetdonation` returned `Invalid params` for a junk address, which is the parameter
validation doing its job, not a failure — a real donation test needs a funded node.

## How you actually join, which is not what the repo's configs say

Three corrections to the first two passes, all found by the node refusing to start:

1. **The shipped configs do not load against their own current code.**
   `do_not_manipulate_config` and `[crosslink] listen_address` are no longer valid fields.
   `zebrad` exits with `unknown field`.
2. **Neither `ClRn` nor `ClTn` has a genesis.** `start.rs:421-428` special-cases exactly two
   networks — regtest, and `ClT0` from a hardcoded `ClT0-genesis.pow` — and panics
   `unhandled special-case genesis` for anything else. The magic that works is
   `[67,108,84,48]` = **ClT0**, which is in *none* of the shipped `.toml` files.
3. **`zebrad generate` emits the correct config**, because it calls `crosslink_default()`
   (`zebrad/src/config.rs:238`). That is the answer to "how do I join": generate, then change
   only your paths and ports. I hand-wrote a config before checking what the tool produced and
   it cost two failed starts.

`crosslink_default()` is also the authoritative answer to the port question: `rpc listen_addr`
`127.0.0.1:8232`, P2P `[::]:8233`, `internal_miner = true`, genesis
`05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38`, and **four bootstrap peers
compiled into the binary** (`70.34.201.146`, `70.34.209.22`, `70.34.195.191`, `70.34.209.18`).
No DNS seed, no seeder.

## Disk and sync — I got this wrong first and the corrected number is the one to use

**Retracted:** an earlier report of mine said the chain state was "megabytes not gigabytes" and
that the chain was "~250 blocks old". Both were wrong. I read my own still-syncing node's
height and reported it as the network's. Recording it here because the wrong number is more
useful as a caution than quietly deleting it.

Measured instead:

| | |
|---|---|
| my node | 485 blocks, 8.7M on disk |
| `estimatedheight` | **372,655** |
| `verificationprogress` | 0.00115 — my node was at 0.1% |
| observed | 20.8 KB/block, ~114 blocks/min catch-up |

Cross-checked rather than trusting one field: block 485's timestamp is 107.7 days old
(mid-April 2026), and `(372,655 − 485)` blocks across those 107.7 days implies **25.0s per
block**, which is plausible for a fast test net. Two independent signals agree, so the estimate
is credible.

> Trap worth recording: the ClT0 **genesis timestamp is `1477648033`**, which is Zcash
> *mainnet's* 2016 genesis time. The genesis is crafted, so it cannot be used to date the
> chain — it would have produced a second wrong answer.

So: **~7.4 GB extrapolated as a floor** (early blocks are sparse; zaino's separate 4 GB cap is
on top), and **~54 hours of initial sync**. Against the box's 28 GB free that is possible but
not comfortable, and the two-day sync happens alongside a live faucet.

## The honest read for the owner

Everything technical says yes: it runs headless, the wallet works headless, the RPC surface is
complete, and the indexer is embedded. The reservations are about the target's maturity, not
our ability to build:

- the state directory the node creates is named
  `zebra_crosslink_workshop_season_one_v3_ehtedht_cache_delete_me`
- the example configs do not load against the code they ship with
- bootstrap is four IP literals compiled into the binary, with no discovery behind them

Against that, the chain has been producing a block every 25 seconds for three and a half
months, which is not a toy. Both things are true at once, and "buildable" and "ready to
depend on" are different questions.

---

# Fourth pass: step 3, the client path — and two things I had backwards

## Q3 is proven

```
zingo-cli --chain testnet --server http://127.0.0.1:39234 --waitsync balance
```

Against the **embedded** zaino of a headless crosslink `zebrad`, a stock Zingo client:

- connected — `vendor: "ZingoLabs ZainoD"`
- derived an Orchard-containing unified address, `utest158076np9ng…`
- **completed a sync** and returned a balance structure

The first pass called this "very likely". It is now observed.

The reason it works, which resolves the consensus-parameter worry properly: **zaino reports the
network's real parameters to the client.** `GetLightdInfo` returned
`sapling_activation_height: 1` and `consensus_branch_id: "c8e71055"` (NU6) — ClT0's values, not
stock testnet's. The client does not need to know about ClT0 in advance.

Worth recording anyway: `zingo-cli --chain` accepts only `mainnet` or `testnet`. zingolib's
`ChainType::Regtest(ConfiguredActivationHeights)` can express an arbitrary network, but the CLI
has no syntax for it (`ChainFromStringError::UnknownRegtestChain` says so outright). It did not
matter here because the server supplies the parameters, but it would matter for anything that
needs the client to know activation heights locally.

## Their faucet: I had this backwards

An earlier pass said "they already have a faucet… we may not be the interesting contribution."
**Withdrawn.** I had not read the queue consumer:

```rust
miner_wallet.send_orchard_to_orchard_zats(..., miner_usk, FAUCET_VALUE, ...)
```

`requestfaucetdonation` **pays from the node's own mining wallet**. It is not a network service
that funds callers; it is a per-node feature meaning *this node will donate its own mining
proceeds*. Calling it against my node returned `{"amount": 50000000}` (0.5 TAZ) and moved
nothing, which is correct — my node has `internal_miner = false` and an empty wallet.

The complete control surface, from `wallet/src/lib.rs:3186` and `:4461`:

| | |
|---|---|
| amount | `FAUCET_VALUE = 50_000_000`, fixed |
| queue | 16 deep; `"faucet too busy, come back later"` when full |
| concurrency | one at a time, and only when the wallet has no other action in flight |
| dedupe | rejects an address whose *previous request is still pending* |
| everything else | none |

There is no cooldown once the queue drains, no per-address history, no daily cap, no IP
limiting, no accounting, no reserve management, no UI. The memo is hardcoded.

So our faucet is not redundant with theirs — it is the missing half. Rate limiting, abuse
handling, the readiness gate, reserve and refill, backups, the verification layer: all of it is
precisely what theirs does not have.

> Method note: my first two `requestfaucetdonation` calls returned `Invalid params` and I
> nearly wrote that up as their validation rejecting a valid address. `z_validateaddress` said
> the address was fine, which is what sent me to the signature instead: it takes a
> `FaucetRequest` **struct**, so params are `[{"address": "..."}]`, not `["..."]`. The error was
> mine.

## Also withdrawn: "Regtest with heights forced to 1 is scaffolding"

An earlier pass called that "the strongest argument against same-box". Not supportable.
zingolib's `ChainType` has three variants and `Regtest(ConfiguredActivationHeights)` is the only
one carrying caller-supplied heights — it is simply how this stack expresses *a custom network*.
ClT0 activates NU6 at height 1 and zaino is handed `nu6: Some(1)`. They match.

The hardcoded `"xxxxxx"` validator credentials are still odd, and the `0.0.0.0` bind still
stands — now **observed** rather than inferred. With P2P on 29233:

```
127.0.0.1:29232   zebrad RPC
127.0.0.1:29233   P2P
127.0.0.1:39233   zaino JSON-RPC   (P+10000)
*:39234           zaino gRPC       (P+10001)   <- all interfaces
```

## Two more findings for the same-box decision

1. **Standalone `zainod` does not build from this monorepo.** `zcash_keys` resolves without the
   orchard/sapling features `zebra-state` needs, so the `zaino/` workspace fails to compile
   while the identical code embedded in `zebrad` builds fine. Running zaino as its own service,
   the way our z3 stack does, is broken today.
2. Their own code logs, in capitals:
   `WAITING 10 SECONDS BECAUSE ZAINO WILL CRASH IF IT DOES STUFF BEFORE ZEBRA`. A startup
   ordering race papered over with a sleep — the kind of thing that bites a supervised restart.

## The corrected chain size, independently corroborated

The retraction in the third pass is itself confirmed: the config carries
`network_checkpoint: Some((280520, …))` and a hardfork with `pow_activation_height: 225000`. A
chain with a 280k checkpoint is not a few hundred blocks. `~7.4 GB` floor and `~54 h` initial
sync stand.

## Where this leaves the owner's question

Technically the answer is yes, and it is now demonstrated rather than argued: headless node,
headless wallet, embedded indexer, working client sync, complete RPC surface, and a faucet
mechanism whose gaps are exactly our strengths. The reservations are about depending on the
target — a workshop-named data directory, sample configs that do not load, four compiled-in
bootstrap IPs, a standalone indexer that does not build, and a startup race with a sleep in it.

Both halves are true. "We can build it" is settled; "it is safe to run beside the live faucet
on 28 GB" is a judgement call, and the honest input to it is ~8–12 GB plus a two-day initial
sync next to a running service.
