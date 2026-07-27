# Deploying the shielded faucet on the z3 stack

> **Shortcut:** [`../deploy.sh`](../deploy.sh) automates every step on this page
> on a fresh Docker-equipped VM (DigitalOcean/Linode/Vultr/Hetzner):
>
> ```bash
> NETWORK=testnet FAUCET_DOMAIN=faucet.example.org ./deploy/deploy.sh
> ```
>
> It clones z3, syncs Zebra, starts Zallet, creates the faucet account *after*
> sync (birthday = tip → no rescan), pauses for you to fund the printed address,
> and brings up the faucet + Caddy. Re-runnable; it skips what's already done.
> The manual walkthrough below is the same thing step by step.

This runs the faucet in **shielded mode** (`FAUCET_SENDER=zallet`): it holds
Orchard notes and pays recipients **z→z**. It stands on the
[z3 stack](https://github.com/ZcashFoundation/z3) (Zebra + Zallet) — a real full
node plus a hot shielded wallet — so this is a single always-on box, **not** the
free-tier serverless deploy the transparent faucet used.

```
    internet ─HTTPS─▶ Caddy ─▶ faucet (Next.js) ─┬─ send ──RPC──▶ zallet ◀──▶ zebra
                      (this overlay)             │   (private docker network)   (z3 stack)
                                                 │
                                                 └─ read (balance/network lookups)
                                                    ──▶ public Zaino  (testnet.zec.rocks)

  Only Caddy is public. The wallet RPC never leaves the private network. The
  read-side lookups use a public Zaino by default — self-host it with one toggle.
```

## Sizing

| | Testnet | Mainnet |
|---|---|---|
| CPU | 2+ cores | 4+ cores |
| RAM | 8 GB | 16+ GB |
| Disk | ~30 GB SSD | ~300 GB SSD |
| Initial sync | 2–12 h | 24–72 h |

## 1. Bring up the z3 stack

```bash
git clone https://github.com/ZcashFoundation/z3 && cd z3
./scripts/setup-network.sh testnet
docker compose --env-file .env.testnet up -d zebra
./scripts/check-zebra-readiness.sh 18080     # waits until Zebra is synced
docker compose --env-file .env.testnet up -d # starts zallet
```

This brings up **zebra + zallet only** — that's all the faucet needs. The
standalone Zaino indexer is *not* started (no `--profile indexer`); the faucet
uses a public Zaino for its read-side lookups by default (see below).

Zebra must finish syncing before Zallet is useful — that's the long one-time wait.
**Create the faucet account only after Zebra is synced** (step 3): the wallet's
birthday is set to the chain tip at creation, so a synced-first order means it
has essentially no history to scan and is usable immediately.

## 2. Authorize the faucet on Zallet's RPC

Zallet's own RPC server needs an auth user (separate from Zebra's cookie, which
z3 handles). Add the block from [`zallet-rpc-auth.example.toml`](zallet-rpc-auth.example.toml)
to `z3/config/testnet/zallet.toml` with a long random password, then:

```bash
docker compose --env-file .env.testnet up -d zallet   # restart with the new auth
```

## 3. Create the faucet's shielded account

```bash
cd z3
docker compose --env-file .env.testnet exec zallet \
  zallet-zaino -d /var/lib/zallet rpc z_getnewaccount '"faucet"'          # → account UUID
docker compose --env-file .env.testnet exec zallet \
  zallet-zaino -d /var/lib/zallet rpc z_getaddressforaccount '"<uuid>"'   # → utest1… address
```

Fund that `utest1…` address with testnet TAZ (a faucet, or shield an existing
`tm…` balance). Notes are spendable after `ZALLET_MIN_CONF` confirmations.

## 4. Run the faucet overlay

From this directory (`deploy/z3/`):

```bash
cp faucet.env.example faucet.env
#   fill in ZALLET_RPC_USER/PASSWORD (from step 2),
#          ZALLET_ACCOUNT/ADDRESS (from step 3),
#          RATE_LIMIT_SALT, Turnstile keys, FAUCET_DOMAIN…

export FAUCET_DOMAIN=faucet.example.org        # your hostname → auto-HTTPS
#   (or leave unset for a plain-HTTP :80 smoke test)

docker compose -f docker-compose.faucet.yml up -d --build
```

The app attaches to z3's `z3-testnet` network and reaches Zallet at
`http://zallet:28232/`. Caddy serves the public site with automatic TLS.

> Mainnet: bring up the mainnet z3 project instead, and set
> `Z3_NETWORK_NAME=z3-mainnet` when running the overlay.

## 5. Verify

```bash
curl -s https://faucet.example.org/api/status | jq   # sender:"zallet", a real balance, empty:false once funded
```

Then request a drip to any `utest1…` from the site — it returns a real txid.

## Light client (Zaino) — public by default

The faucet needs a light-client (Zaino / lightwalletd) endpoint for the *read*
side only: the "check this address" balance lookup and network status on the
site (`/api/balance`, `/api/network`). Sending is done by Zallet and never
touches this. So by default the overlay points at a **public Zaino**:

```
LIGHTWALLETD_ENDPOINT=https://testnet.zec.rocks:443   # in faucet.env
```

That's the whole wiring — nothing to run. Keep it this way unless you want zero
external dependencies.

**To self-host it** (fully sovereign, one extra container): start z3's bundled
Zaino and point the faucet at it over the shared network:

```bash
# in the z3 dir — add the indexer profile
docker compose --env-file .env.testnet --profile indexer up -d
```
```
# in faucet.env — reach it by service name on the z3 network (gRPC port 8137)
LIGHTWALLETD_ENDPOINT=http://zaino:8137
```

Then `docker compose -f docker-compose.faucet.yml up -d` to pick up the change.

## Monitoring and alerts

The watchdog can post to a Slack or Discord webhook when the faucet is
genuinely un-servable, and `faucet-metrics.sh` writes balance, queue depth
and sync state to a Prometheus textfile every 30 seconds.
[OBSERVABILITY.md](OBSERVABILITY.md) covers both.

## Fast rebuild from a snapshot

Zebra's initial sync is the only day-long step above. [SNAPSHOTS.md](SNAPSHOTS.md)
documents the zsnap tooling that removes it from the recovery path: a systemd
timer exports the synced chain state on a schedule (live-safe, read-only), and
a fresh box imports the latest snapshot before zebra starts, via one URL in
`cloud-init.yaml`.

## Operating notes

- **Hot wallet.** Zallet holds spending keys. Keep the box locked down, keep
  Zebra/Zallet RPC **off the public internet** (this overlay never publishes
  them), and hold only what the faucet needs.
- **Backups.** Back up z3's `z3-<net>-zallet` volume (encrypted DB + identity)
  and this dir's `faucet_data` volume (rate-limit ledger).
- **Keep it awake / restart-safe.** Everything is `restart: unless-stopped`;
  after a reboot, `docker compose … up -d` both projects.
- **Monitoring (optional).** Add `--profile monitoring` to the z3 stack for
  Grafana/Prometheus dashboards.

### Self-healing watchdog

`watchdog.sh` plus `faucet-watchdog.service` keep the stack up without a human on
SSH. It forces `restart=unless-stopped` on every container, restarts anything
that has exited (this is what recovers Zallet when it drops on a mempool-stream
close), restarts `faucet-web` if it hangs, and pages on sustained un-readiness.
A fresh box installs and enables it automatically via `cloud-init.yaml`.

Install it on a box that was set up before the watchdog existed:

```bash
install -D -m 0755 /opt/zcash-faucet/deploy/z3/watchdog.sh /opt/faucet/watchdog.sh
install -m 0644 /opt/zcash-faucet/deploy/z3/faucet-watchdog.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now faucet-watchdog
journalctl -u faucet-watchdog -f    # watch it work
```

Tune it with an optional `/etc/faucet/watchdog.env` (`WATCHDOG_ALERT_URL` for a
Slack/Discord webhook, `WATCHDOG_INTERVAL`, the `WATCHDOG_*_MATCH` container name
patterns). Readiness is `GET /api/ready` (200 can-serve, 503 with a reason);
liveness is `GET /api/health`.
