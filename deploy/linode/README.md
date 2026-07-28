# Linode: production deploy in three steps

Same recipe as the [DigitalOcean guide](../digitalocean/README.md): one pasted
[`cloud-init.yaml`](../cloud-init.yaml), one DNS record, one funding tx. Only
the click-path differs.

## 1. Create the Linode (~2 min)

From [cloud.linode.com](https://cloud.linode.com) → **Create Linode**:

- **Image**: Ubuntu 24.04 LTS
- **Region**: one near you (core regions all support cloud-init user data)
- **Plan**: Shared CPU → **Linode 8 GB** (4 vCPU / 160 GB), the sweet spot.
  Light testnet duty also runs on Linode 4 GB + the cloud-init's swap, but 8 GB
  is the comfortable floor for node + wallet + proofs.
- **Label**: `zcash-faucet` · set a root password · add your SSH key
- Scroll to **Add User Data** and paste the whole of
  [`../cloud-init.yaml`](../cloud-init.yaml), after editing its one marked
  line (your domain, or delete that line to test over plain HTTP first).
- **Create Linode**.

> Don't see "Add User Data"? That region lacks the Metadata service. Either
> pick another region, or create the Linode anyway and run the same thing by
> hand. It's three commands:
> ```bash
> ssh root@<ip>
> curl -fsSL https://get.docker.com | sh && apt-get install -y git
> git clone https://github.com/jinolabs-xyz/zcash-faucet /opt/zcash-faucet
> echo "faucet.example.org" > /etc/faucet-domain
> NONINTERACTIVE=1 /opt/zcash-faucet/deploy/deploy.sh 2>&1 | tee /var/log/faucet-deploy.log
> ```

## 2. Point DNS (~1 min)

An **A record**: `faucet.example.org → <Linode IP>` (the IP is on the Linode's
summary page). Caddy provisions the HTTPS certificate on its own.

## 3. Watch the sync, then fund

```bash
ssh root@<ip> tail -f /var/log/faucet-deploy.log
```

Initial chain sync is a one-time few hours. When the log prints the faucet's
`utest1…` address (also saved at `/opt/zcash-faucet/deploy/.faucet-account`),
send it testnet ZEC. The wallet is created *after* sync, so deposits appear
within a block or two.

The site is live the whole time. Until funded, claims get a clean
"faucet empty". After funding: **users paste an address, click, get a txid**,
and shielded recipients are paid fully privately.

## Production checklist

Same as DigitalOcean: see [the checklist there](../digitalocean/README.md#production-checklist)
(secrets, Turnstile, backups via Linode's Backup service or the two named
volumes, UptimeRobot on `/api/health`, `--profile monitoring` for Grafana,
updates via `git pull && faucet-up`).
