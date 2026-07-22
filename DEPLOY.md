# Deploying the faucet (free: Render + Cloudflare)

Verified stack: **Render** (web app, free) + **Cloudflare** (D1 ledger + Turnstile +
DNS/CDN, free) + **UptimeRobot** (keep-alive ping, free).

## Pre-flight: what's already verified

A clean-room run of Render's exact sequence (`npm ci → npm run build → npm run
start` with an injected `PORT`) passes:

- ✅ clean install from `package-lock.json`
- ✅ production build
- ✅ binds `0.0.0.0:$PORT` (Render's requirement) — confirmed on an injected port
- ✅ `/api/health` responds; drip (mock), account gen, and live-gRPC balance/network all work
- ✅ `TRUSTED_PROXY_COUNT=1` correctly reads the client IP behind Render's proxy, and a spoofed `X-Forwarded-For` prepend is rejected

## 1. Deploy the web service on Render

Render can't be driven headless — do this in the dashboard (one-time):

1. Push this repo to GitHub (already at `github.com/jinolabs-xyz/zcash-faucet`).
2. Render → **New → Blueprint** → connect the repo. It reads [`render.yaml`](render.yaml)
   and creates a free web service (build/start/health all preconfigured).
3. Set the secret env vars (marked `sync: false`) in the dashboard:
   - `RATE_LIMIT_SALT` — a long random string
   - `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` — from Cloudflare
   - `FAUCET_DONATION_ADDRESS` — the faucet's receive address (optional)
   - `FAUCET_WALLET_SEED` — only once you flip `FAUCET_SENDER=webzjs`
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

# 4. deploy — note the printed https://zcash-faucet-db.<subdomain>.workers.dev URL
npx wrangler deploy
```

Then in the Render dashboard set:

- `DB_BACKEND` = `d1`
- `D1_PROXY_URL` = the Worker URL from step 4
- `D1_PROXY_SECRET` = the same value you set in step 3

The app's `db/` driver switches to the Worker when `DB_BACKEND=d1`; otherwise it
uses local file SQLite (dev). The atomic claim reservation runs as one conditional
`INSERT`, so it's race-safe on D1-over-HTTP too — load-tested with 5 concurrent
requests (exactly one wins).

## 3. Keep it awake (UptimeRobot)

1. [UptimeRobot](https://uptimerobot.com) (or [cron-job.org](https://cron-job.org)) → new **HTTP(s)** monitor.
2. URL: `https://<your-app>.onrender.com/api/health` — interval **5 min**.
   `/api/health` is intentionally cheap (no gRPC/DB), so pinging it is free of side effects.

Render free gives ~750 instance-hours/month; one always-pinged service (~730h) fits.

## 4. Real sends (moving real TAZ)

The faucet spends a funded **transparent** testnet wallet. Transparent sends
need no zk-proof, so this runs on the free tier. What's already verified:
wallet derivation, real balance over lightwalletd, transparent tx build+sign
(valid Sapling v4, decodes cleanly), and broadcast wiring. The one thing that
needs you is a **funded wallet + one real broadcast** — that's the acceptance
test I can't run.

1. **Get a wallet + address.** Use the Account tab (or any tool) to make a
   transparent testnet account — you get a `tm…` address and a WIF private key.
2. **Fund its `tm…` address** from an existing faucet (faucet.zecpages.com,
   fauzec.com) or the Zcash Discord `#testnet` channel.
3. **Set secrets** (Render dashboard, never commit):
   - `FAUCET_SENDER=real`
   - `FAUCET_WALLET_SEED=<the WIF>` (or a 64-hex key)
4. **First claim is the acceptance test.** Request a drip to a `tm…` address and
   confirm the returned txid appears on a testnet explorer. If broadcast is
   rejected, the error carries lightwalletd's reason (e.g. bad branch id / fee).

### Shielded recipients

Real **shielded** sends (`utest1…`/`ztestsapling1…`) are intentionally refused
in real mode with a clear message. Reason: creating a shielded output needs a
zk-proof, and its change lands in an Orchard pool this transparent wallet can't
re-spend — the faucet would slowly strand its own funds. To enable them
properly you need a sweep-capable shielded wallet: run **Zallet + Zebra (Z3)**
and add a `ZalletSender` (same `Sender` interface), or periodically sweep the
Orchard change back to the transparent wallet. Until then, point users at a
`tm…` address for real TAZ.

zk-proving, if you add it, is memory-heavy — expect to move off Render's 512 MB
free instance to its cheapest paid tier. See the README "Design principles."
