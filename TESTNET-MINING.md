# Mine a Zcash testnet block on a CPU

You do not need special hardware. Testnet has a minimum-difficulty rule: when
blocks are far enough apart the target drops to the network floor, and at the
floor one core finds a block in a reasonable time. That is why this works here
and would be pointless on mainnet, where you should not point a CPU miner at
all.

This is written for someone who has not done it before. It is four steps, and
the third one is waiting.

Asked for by dismad in the Zcash community. The operator-facing version of this,
with our tuning and service files, is [deploy/z3/MINING.md](deploy/z3/MINING.md).

## What you need

- A machine that can leave a process running for hours
- About 10 GB of disk for testnet chain state, and it grows over time. Zebra's
  own [system requirements](https://zebra.zfnd.org/user/requirements.html) put
  testnet at roughly 10 GB against 300 GB for mainnet, with a 2-core, 4 GB RAM
  minimum
- Rust, if you build the miner from source (`rustup` is enough)

## 1. Get a testnet node running

Zebra is the Zcash Foundation's node. Docker is the shortest path:

```sh
docker run -d --name zebra-testnet \
  -v zebra-testnet-cache:/home/zebra/.cache/zebra \
  -p 127.0.0.1:18232:18232 \
  -e ZEBRA_NETWORK__NETWORK=Testnet \
  -e ZEBRA_RPC__LISTEN_ADDR=0.0.0.0:18232 \
  -e ZEBRA_RPC__ENABLE_COOKIE_AUTH=false \
  -e ZEBRA_MINING__MINER_ADDRESS=<your testnet address> \
  zfnd/zebra:6.2.0
```

Four things in there matter and are easy to get wrong.

**The volume path has to be exactly that.** `/home/zebra/.cache/zebra` is where
the image keeps chain state. Mount somewhere else and the container starts fine,
syncs happily, and then throws all of it away on the next restart, with nothing
in the logs to tell you why you are syncing again.

**The mining address is zebra's, not the miner's.** `ZEBRA_MINING__MINER_ADDRESS`
is what the coinbase pays. The mining program never chooses where the money
goes, it only solves the block zebra hands it. Use a testnet address you control:
transparent `tm…` is simplest to check on an explorer. You can get one from
[the faucet](https://zcashfaucet.jinolabs.xyz) if you do not have a wallet set up yet.

**Bind the RPC to localhost.** The `-p 127.0.0.1:18232:18232` above is the part
doing that. An open Zcash RPC port lets a stranger read your chain and submit
blocks through your node. Docker writes its own iptables rules ahead of a
host firewall, so `ufw deny 18232` will not save you here. The binding is the
control.

**`enable_cookie_auth=false` is a convenience for a local experiment.** It is
fine behind a localhost binding and not fine on anything reachable. With cookie
auth on, your miner needs the path to zebra's `.cookie` file.

Those variable names are zebra's documented Docker form, where a double
underscore is a nested config section. The full list is in
[zebra's Docker docs](https://zebra.zfnd.org/user/docker.html).

Running zebrad directly instead of in Docker, the same settings in `zebrad.toml`:

```toml
[network]
network = "Testnet"

[rpc]
listen_addr = "127.0.0.1:18232"
enable_cookie_auth = false

[mining]
miner_address = "<your testnet address>"
```

## 2. Wait for the sync, and do not mine yet

```sh
docker logs -f zebra-testnet
```

This is the long step. Hours, not minutes.

**Do not start mining before the node is synced.** A node still catching up does
not know the real tip, so it builds templates on a chain the network has already
moved past. You will burn CPU producing blocks nobody can use, and if you submit
them you fork yourself off the chain you were trying to join. Wait it out.

You can tell you are close by comparing your height to a source that is not your
own node, for example [a public explorer](https://testnet.zcashexplorer.app) or
the [hosh dashboard](https://hosh.zec.rocks) which lists the tip every public
testnet server reports.

## 3. Point a miner at it

Any Equihash 200,9 miner that speaks `getblocktemplate` and `submitblock` will
do. The one in this repo is small, reads top to bottom, and is the one we
actually run:

```sh
git clone https://github.com/jinolabs-xyz/zcash-faucet
cd zcash-faucet/deploy/z3/miner
cargo build --release
```

It uses the Equihash solver from `librustzcash`, the same one zebra's internal
miner uses, so nothing about the proof of work is hand-rolled.

Run it in the safe mode first:

```sh
MINER_MODE=proposal \
MINER_RPC_URL=http://127.0.0.1:18232 \
MINER_THREADS=1 \
./target/release/zcash-testnet-miner
```

`proposal` mode solves a block and then asks zebra to validate it through
`getblocktemplate mode=proposal`. Zebra runs its full check and **nothing is
submitted**. When you see `proposal VALID` you have mined a block that the
network would accept, without touching the chain. That is the moment worth
stopping at, because it proves the whole path works.

Then, for real:

```sh
MINER_MODE=submit MINER_RPC_URL=http://127.0.0.1:18232 MINER_THREADS=1 \
  ./target/release/zcash-testnet-miner
```

One thread is a fine starting point. More threads cost roughly 144 MB each and
help less than you would expect, because what limits you is how often the
difficulty floor arrives, not how fast you hash.

## 4. Set your expectations correctly

This is the part a guide usually leaves out, and it is the part that makes people
think they did something wrong.

**Most blocks you win will be orphaned.** One miner wins nearly every height on
testnet, and they find blocks far more often than you will. You lose most
propagation races to them. That is ordinary orphaning rather than anything being
misconfigured.

**Some do survive.** We watched eight in a row get orphaned and the ninth stick,
and the block after ours was built on top of it by that same large miner. So they
are following the same chain you are, and survival is genuinely nonzero.

**Nobody should quote you a rate, including us.** One survivor in nine wins looks
like 11%, but at nine samples the 95% interval runs from about 0.3% to 48%. That
constrains nearly nothing. Do not plan around a number, and do not read the next
orphan or the next survivor as news.

**Coinbase is not spendable immediately.** A block reward needs 100 confirmations
before you can spend it, which is a couple of hours at testnet's 75-second
target. A balance of zero right after winning a block is correct, not broken.

## Checking it worked

```sh
# your node's tip
curl -s -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getblockchaininfo","params":[]}' \
  http://127.0.0.1:18232 | jq '.result.blocks'
```

Then look up your mining address on an explorer you do not run. Your own node
agreeing with itself is not evidence: it will happily show you a block the rest
of the network discarded, which is exactly how the eight orphans above looked
from the inside.

## If it is not working

| symptom | likely cause |
|---|---|
| miner cannot reach the RPC | zebra not up yet, wrong port, or cookie auth on while the miner has no cookie path |
| `proposal` never says VALID | node not synced, so the template is built on a stale chain |
| blocks solved but never accepted | you are submitting from an unsynced node, or losing every race, which is normal |
| balance stays zero after a win | coinbase maturity, 100 confirmations, or the block was orphaned. Check the address on an explorer |
| solving takes forever | the difficulty floor has not arrived. It comes in bursts, so leave it running |
