# Deploying the faucet

Two paths. Pick by what you are doing.

| Path | Needs | Use it for |
|---|---|---|
| [Local, mock mode](#local-mock-mode) | Node 23, nothing else | Working on the app. No keys, no chain, no wallet, no coins move. |
| [A real server](#a-real-server-the-z3-stack) | One VM | The actual faucet: Zebra, Zallet, the miner, Caddy and TLS. |

## Local, mock mode

Runs the entire flow with no keys, no chain and no wallet. The mock sender keeps
a simulated balance, so the low-balance guard, the empty state and the whole
claim path are all exercisable.

```bash
npm install
npm run build
FAUCET_SENDER=mock FAUCET_CHALLENGE=pow RATE_LIMIT_SALT=dev-salt npm start
```

Open http://localhost:3000, hit **Generate a test address**, and claim.

To watch the reserve loop refill, add `FAUCET_SHIELD_COINBASE=true
FAUCET_MOCK_REFILL=true` and set the marks low, for example
`FAUCET_RESERVE_LOW_TAZ=4 FAUCET_RESERVE_TARGET_TAZ=8`.

`FAUCET_SHIELD_COINBASE` is the switch that lets the loop move funds, and it is
deliberately **not** `FAUCET_MINER_ACTIVE` — that one is about mining, which the
app does not do. Either flag arms the loop so it observes and reports; only this
one lets it sweep (#172).

**`npm run dev` does not bundle.** A `node:` import in `src/lib/zcash/t2z.ts`
breaks the dev webpack build, so use `npm run build && npm start`.

Every setting is in [CONFIGURATION.md](CONFIGURATION.md).

## A real server (the z3 stack)

This is how the faucet actually runs: one VM with a Zebra full node, a Zallet
shielded wallet, the solo miner, the app, and Caddy terminating TLS.

Fresh box, paste-once:

```bash
# Provision with deploy/cloud-init.yaml, which brings the whole stack up on
# first boot. See deploy/linode/ or deploy/digitalocean/ for provider notes.
```

Existing box, re-runnable and safe to repeat:

```bash
cd /opt/zcash-faucet
git pull
NETWORK=testnet FAUCET_DOMAIN=$(cat /etc/faucet-domain) ./deploy/deploy.sh
```

### Letting the faucet refill itself

Mining rewards land as transparent coinbase at `FAUCET_MINER_ADDRESS`. They are
not spendable by the faucet until the reserve loop shields them into the wallet,
and **that is off by default**, because shielding broadcasts a transaction and
that stays a deliberate authorisation:

```bash
# in the faucet env, then restart the app
FAUCET_SHIELD_COINBASE=true
```

This is **not** `FAUCET_MINER_ACTIVE`. That one is about mining, which the app
does not do. Either flag arms the loop so it observes and reports, but only this
one lets it move funds. They were a single flag until #172, where turning mining
off also turned fund recovery off and left 47.5 TAZ unswept through a shortage.

With it off and a refill needed, the loop logs that every tick, so the state is
loud rather than silent. Check it without reading logs:

```bash
curl -s localhost:3000/api/status | jq .reserve
# refilling: true + shieldCoinbase: false  → it wants to refill and may not
# blindTicks > 0                           → it cannot read the balance at all
```

The stack, its wallet setup and the RPC wiring are documented in
[deploy/z3/README.md](deploy/z3/README.md). TLS and DNS are in
[deploy/z3/HTTPS.md](deploy/z3/HTTPS.md). Day-two operations, health versus
readiness, backups, snapshots and the 3am runbook are in
[OPERATIONS.md](OPERATIONS.md).

## Legacy: Render plus Cloudflare

Kept because `render.yaml` and the D1 proxy Worker are still in the repo and
still work, but this predates the z3 stack. It runs the app against a public
lightwalletd with the ledger on Cloudflare D1, which means no full node and no
shielded faucet wallet. Use the z3 path above for anything real.

## Pre-flight: what's already verified

A clean-room run of Render's exact sequence (`npm ci → npm run build → npm run
start` with an injected `PORT`) passes:

- ✅ clean install from `package-lock.json`
- ✅ production build
- ✅ binds `0.0.0.0:$PORT` (Render's requirement), confirmed on an injected port
- ✅ `/api/health` responds, and drip, account gen, and live-gRPC balance/network all work
- ✅ `TRUSTED_PROXY_COUNT=1` correctly reads the client IP behind Render's proxy, and a spoofed `X-Forwarded-For` prepend is rejected

## 1. Deploy the web service on Render

Render can't be driven headless, so do this in the dashboard (one-time):

1. Push this repo to GitHub (already at `github.com/jinolabs-xyz/zcash-faucet`).
2. Render → **New → Blueprint** → connect the repo. It reads [`render.yaml`](render.yaml)
   and creates a free web service (build/start/health all preconfigured).
3. Set the secret env vars (marked `sync: false`) in the dashboard:
   - `RATE_LIMIT_SALT`: a long random string
   - `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`: from Cloudflare
   - `FAUCET_DONATION_ADDRESS`: the faucet's receive address (optional)
   - `FAUCET_WALLET_SEED`: only once you flip `FAUCET_SENDER=real`
4. Deploy. You get `https://zcash-faucet.onrender.com` (or your custom domain).

> Free tier caveats, both handled: it **spins down after 15 min** (step 3 below
> keeps it warm) and has an **ephemeral disk** (step 2 moves the ledger to D1).

## 2. Move the ledger to Cloudflare D1 (survives restarts)

Render's free disk is wiped on every restart/redeploy, which would reset the
rate-limit ledger. Point it at D1 (SQLite, free) via the proxy Worker in
[`worker/`](worker/). All of this is verified locally, including that a fresh app
process still sees prior cooldowns (i.e. restart-safe).

```bash
cd worker
npm install
npx wrangler login

# 1. create the D1 database, paste the printed database_id into wrangler.jsonc
npx wrangler d1 create zcash-faucet-db

# 2. create the schema on the remote DB
npx wrangler d1 execute zcash-faucet-db --remote --file schema.sql

# 3. set the shared secret the app will authenticate with (pick a long random one)
npx wrangler secret put PROXY_SECRET

# 4. deploy, then note the printed https://zcash-faucet-db.<subdomain>.workers.dev URL
npx wrangler deploy
```

Then in the Render dashboard set:

- `DB_BACKEND` = `d1`
- `D1_PROXY_URL` = the Worker URL from step 4
- `D1_PROXY_SECRET` = the same value you set in step 3

The app's `db/` driver switches to the Worker when `DB_BACKEND=d1`. Otherwise it
uses local file SQLite (dev). The atomic claim reservation runs as one conditional
`INSERT`, so it's race-safe on D1-over-HTTP too: load-tested with 5 concurrent
requests (exactly one wins).

## 3. Keep it awake (UptimeRobot)

1. [UptimeRobot](https://uptimerobot.com) (or [cron-job.org](https://cron-job.org)) → new **HTTP(s)** monitor.
2. URL: `https://<your-app>.onrender.com/api/health`, interval **5 min**.
   `/api/health` is intentionally cheap (no gRPC/DB), so pinging it is free of side effects.

Render free gives ~750 instance-hours/month, so one always-pinged service (~730h) fits.

## 4. Real sends (moving real TAZ)

The faucet spends a funded **transparent** testnet wallet. Transparent sends
need no zk-proof, so this runs on the free tier. What's already verified:
wallet derivation, real balance over lightwalletd, transparent tx build+sign
(valid Sapling v4, decodes cleanly), and broadcast wiring. The one thing that
needs you is a **funded wallet + one real broadcast**: that's the acceptance
test I can't run.

1. **Get a wallet + address.** Use the Account tab (or any tool) to make a
   transparent testnet account. You get a `tm…` address and a WIF private key.
2. **Fund its `tm…` address** from an existing faucet (faucet.zecpages.com,
   fauzec.com) or the Zcash Discord `#testnet` channel.
3. **Set secrets** (Render dashboard, never commit):
   - `FAUCET_SENDER=real`
   - `FAUCET_WALLET_SEED=<the WIF>` (or a 64-hex key)
4. **First claim is the acceptance test.** Request a drip to a `tm…` address and
   confirm the returned txid appears on a testnet explorer. If broadcast is
   rejected, the error carries lightwalletd's reason (e.g. bad branch id / fee).

### Shielded recipients in `real` mode

In `real` mode the transparent wallet still pays **unified** recipients
(`utest1…`) via a transparent→Orchard t2z tx, with change routed back to its own
`tm…` address so funds re-circulate. Sapling-only recipients (`ztestsapling1…`)
aren't payable this way (t2z emits Orchard outputs). But note the privacy limit:
the faucet's balance and every drip's transparent origin are public. For a
faucet that's shielded *end to end*, use `zallet` mode below.

## 5. Shielded faucet (Zallet + Zebra, the Z3 stack)

`FAUCET_SENDER=zallet` makes the faucet genuinely shielded: it holds **Orchard
notes** and pays recipients **z→z**, so the faucet's holdings and the link
between faucet and claimant stay private, and it can pay Sapling recipients too.
The cost is that you run a node: this is not a free-tier, no-node deploy.
zk-proving is CPU/RAM-heavy (tens of seconds per send), so size the box
accordingly, well above Render's 512 MB free instance.

> **Linode / DigitalOcean, three steps:** paste [`deploy/cloud-init.yaml`](deploy/cloud-init.yaml)
> at VM creation, point DNS, fund the printed address. The box self-configures
> (Docker, firewall, swap, full stack). Click-paths: [`deploy/linode/`](deploy/linode/) ·
> [`deploy/digitalocean/`](deploy/digitalocean/).
>
> **Turnkey deploy:** [`deploy/z3/`](deploy/z3/) is a Docker Compose overlay that
> runs the faucet + a Caddy reverse proxy (auto-TLS) on top of the
> [z3 stack](https://github.com/ZcashFoundation/z3) (Zebra + Zallet), with only
> the web app exposed. Follow [`deploy/z3/README.md`](deploy/z3/README.md) for the
> single-box VPS runbook. The manual walkthrough below is the same thing by hand
> (what this repo was validated against locally).

**The stack:** `zebrad` (full node) → `zallet-zaino` (wallet + embedded zaino
indexer, reaching the chain over zebrad's JSON-RPC) → the faucet, which drives
zallet's JSON-RPC. Verified locally end to end except a *funded* send (needs
testnet TAZ). The setup, exactly as run:

```bash
# 0. Build the zaino-backend wallet binary (its own cargo workspace).
git clone https://github.com/zcash/wallet.git
cargo build --release --features rpc-cli \
  --manifest-path wallet/backends/zaino/Cargo.toml      # → zallet-zaino

# 1. Run zebrad on TESTNET with JSON-RPC on 127.0.0.1:18232 (localhost only).
#    [network] network="Testnet"  [rpc] listen_addr="127.0.0.1:18232", enable_cookie_auth=false
zebrad -c zebrad.toml start                              # syncs the chain (hours)

# 2. Create the wallet datadir + zallet.toml (backend="zaino",
#    consensus.network="test", [indexer] validator_address="127.0.0.1:18232",
#    [rpc] bind=["127.0.0.1:28232"] + a [[rpc.auth]] user).
zallet-zaino -d "$DD" generate-encryption-identity       # plain on-disk age identity
zallet-zaino -d "$DD" init-wallet-encryption
zallet-zaino -d "$DD" generate-mnemonic
zallet-zaino -d "$DD" start                              # syncs the wallet to the node

# 3. Mint the faucet's shielded account + its unified address.
zallet-zaino -d "$DD" rpc z_getnewaccount '"faucet"'          # → account UUID
zallet-zaino -d "$DD" rpc z_getaddressforaccount '"<uuid>"'   # → utest1… address
```

**Fund it.** Send testnet TAZ to that `utest1…` address (a testnet faucet, or
shield an existing `tm…` balance to it). Received notes are spendable after
`ZALLET_MIN_CONF` confirmations (default 10, drop to 1 on testnet for demos).
Check with `zallet-zaino -d "$DD" rpc z_getbalanceforaccount '"<uuid>"'`.

**Point the faucet at it** (secrets in the host's store, never committed):

- `FAUCET_SENDER=zallet`
- `ZALLET_RPC_URL=http://127.0.0.1:28232/`, `ZALLET_RPC_USER` / `ZALLET_RPC_PASSWORD`
  (the `[[rpc.auth]]` user)
- `ZALLET_ACCOUNT=<uuid>`, `ZALLET_ADDRESS=<utest1…>`

The faucet's balance guard now reads `z_getbalanceforaccount`, and each claim
calls `z_sendmany` (ZIP-317 fees, async opid → polled to a txid). Shielded
recipients get a fully-private send. Transparent recipients are paid with an
explicit `AllowRevealedRecipients` policy (paying a `tm…` address unavoidably
reveals it). The first funded claim is the acceptance test.
