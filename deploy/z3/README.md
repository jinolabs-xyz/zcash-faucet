# Deploying the shielded faucet on the z3 stack

This runs the faucet in **shielded mode** (`FAUCET_SENDER=zallet`): it holds
Orchard notes and pays recipients **z→z**. It stands on the
[z3 stack](https://github.com/ZcashFoundation/z3) (Zebra + Zallet) — a real full
node plus a hot shielded wallet — so this is a single always-on box, **not** the
free-tier serverless deploy the transparent faucet used.

```
        internet ──HTTPS──▶ Caddy ──▶ faucet (Next.js) ──RPC──▶ zallet ◀──▶ zebra
                            (this overlay)        │   http://zallet:28232/   (z3 stack)
                                                  └── only Caddy is public; RPC stays on
                                                      the private docker network
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
docker compose --env-file .env.testnet up -d # starts zallet (+ zaino if you add --profile indexer)
```

Zebra must finish syncing before Zallet is useful — that's the long wait.

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
