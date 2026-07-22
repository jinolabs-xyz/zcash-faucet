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
rate-limit ledger. Point it at D1 instead:

1. `wrangler d1 create zcash-faucet-db`
2. Deploy the tiny proxy Worker (binds D1, checks a shared secret) — see the
   Cloudflare D1 "access from outside a Worker" tutorial.
3. In `db.ts`, the adapter switches to the Worker when `DB_BACKEND=d1` +
   `D1_PROXY_URL` + `D1_PROXY_SECRET` are set; otherwise it uses local file
   SQLite (dev). *(This adapter is the next thing to wire — say the word.)*

## 3. Keep it awake (UptimeRobot)

1. [UptimeRobot](https://uptimerobot.com) (or [cron-job.org](https://cron-job.org)) → new **HTTP(s)** monitor.
2. URL: `https://<your-app>.onrender.com/api/health` — interval **5 min**.
   `/api/health` is intentionally cheap (no gRPC/DB), so pinging it is free of side effects.

Render free gives ~750 instance-hours/month; one always-pinged service (~730h) fits.

## 4. Later: real sends (WebZjs)

Flip `FAUCET_SENDER=webzjs`, set a funded `FAUCET_WALLET_SEED`, and wire the
`WebzjsSender` TODOs. zk-proving is memory-heavy — if it OOMs Render's 512 MB
free instance, bump to Render's cheapest paid tier (still just Render). See the
main README "Design principles" for the decentralization/privacy notes.
