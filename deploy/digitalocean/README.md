# DigitalOcean: production deploy in three steps

The goal: an operator does three things, and end users just paste an address on
the site and receive shielded funds. Everything else is automated by
[`../cloud-init.yaml`](../cloud-init.yaml) + [`../deploy.sh`](../deploy.sh).

## 1. Create the Droplet (~2 min)

- **Create → Droplets** → Ubuntu **24.04 LTS**.
- Size: Basic → Premium AMD/Intel, **4 vCPU / 8 GB / 160 GB** (~$48/mo).
  Light testnet duty runs on 2 vCPU / 8 GB (~$42) too — sends just queue longer.
- **Advanced Options → Add Initialization scripts**: paste the whole of
  [`../cloud-init.yaml`](../cloud-init.yaml), after editing its one marked line
  (your domain — or delete that line for plain HTTP).
- Add your SSH key → **Create Droplet**.

The box then installs Docker (with log rotation), enables the firewall
(SSH + 80/443 only — wallet RPC is never exposed), adds swap, clones the repo,
and starts the full stack: **zebra + zallet + faucet + caddy**, all
`restart: unless-stopped` on persistent volumes. A systemd unit re-runs the
idempotent bring-up on reboot as a belt-and-braces.

## 2. Point DNS (~1 min)

Create an **A record**: `faucet.example.org → <droplet IP>`. Caddy notices and
provisions the HTTPS certificate automatically — nothing to configure.

## 3. Fund it (whenever the sync finishes)

Initial chain sync is a **one-time few hours** (testnet). Watch it:

```bash
ssh root@<ip> tail -f /var/log/faucet-deploy.log
```

When the log prints the faucet's `utest1…` address, send it testnet ZEC.
(The address is also saved in `/opt/zcash-faucet/deploy/.faucet-account`.)
The wallet is created *after* the sync, so it has no history to scan — deposits
show up within a block or two.

That's it. The site is live at `https://faucet.example.org`; until funded it
answers claims with a friendly "faucet empty".

## What your users see

Open the site → paste a `utest1…` / `ztestsapling1…` / `tm…` address → click →
get a txid. Shielded recipients are paid fully privately (z→z). Cooldowns, the
daily cap, and the send queue are already enforced server-side.

## Production checklist

- **Secrets** — `deploy/z3/faucet.env` on the box holds the wallet-RPC password
  and `RATE_LIMIT_SALT` (set a real salt; the script flags it). Never commit it.
- **Anti-abuse** — add Turnstile keys in `faucet.env` (or run without on quiet
  testnets; per-IP cooldown + daily cap still hold).
- **Backups** — enable DO **Snapshots/Backups** on the Droplet, or back up the
  `z3-testnet-zallet` volume (wallet DB + encryption identity) and `faucet_data`
  (rate-limit ledger). The chain volume never needs backup — it re-syncs.
- **Uptime** — point UptimeRobot (free) at `/api/health`.
- **Monitoring (optional)** — in `/opt/zcash-faucet/deploy/z3-stack`:
  `docker compose --env-file .env.testnet --profile monitoring up -d` for
  Grafana/Prometheus dashboards.
- **Updates** — `git -C /opt/zcash-faucet pull && faucet-up` rebuilds the app;
  `docker compose pull` in `deploy/z3-stack` picks up node/wallet updates.
- **Hot wallet discipline** — keep only what the faucet needs; top up the same
  address any time.
