# Operations

The 3am runbook for the faucet box. Every section is short on purpose and
points into the deep doc that owns the topic. The box is a single Ubuntu VM
running docker compose stacks plus a handful of systemd units, with the repo
checked out at `/opt/zcash-faucet`.

## What runs where

| Thing | Runs as | Where | Deep doc |
|---|---|---|---|
| zebra (full node) | docker, z3 project `z3-testnet` | `/opt/zcash-faucet/deploy/z3-stack` | [deploy/z3/README.md](deploy/z3/README.md) |
| zallet (shielded wallet) | docker, same z3 project | `/opt/zcash-faucet/deploy/z3-stack` | [deploy/z3/README.md](deploy/z3/README.md) |
| faucet web app (Next.js) | docker, project `zcash-faucet` | `/opt/zcash-faucet/deploy/z3/docker-compose.faucet.yml` | [deploy/z3/README.md](deploy/z3/README.md) |
| caddy (HTTPS, ports 80/443) | docker, same overlay | same compose file | [deploy/z3/HTTPS.md](deploy/z3/HTTPS.md) |
| boot bring-up | systemd `faucet.service` (oneshot, cloud-init boxes) | runs `/usr/local/bin/faucet-up` | [deploy/cloud-init.yaml](deploy/cloud-init.yaml) |
| watchdog (self-healing) | systemd `faucet-watchdog` | `/opt/faucet/watchdog.sh` | [deploy/z3/watchdog.sh](deploy/z3/watchdog.sh) header |
| solo CPU miner | systemd `zcash-testnet-miner` | `/opt/faucet/zcash-testnet-miner` | [deploy/z3/MINING.md](deploy/z3/MINING.md) |
| chain snapshot export | systemd `zsnap-export.timer` | `/opt/faucet/zsnap-export.sh` | [deploy/z3/SNAPSHOTS.md](deploy/z3/SNAPSHOTS.md) |
| encrypted backups | systemd `faucet-backup.timer` | `/opt/faucet/backup.sh` | [deploy/z3/BACKUPS.md](deploy/z3/BACKUPS.md) |
| metrics textfile | systemd `faucet-metrics.timer` | `/opt/faucet/faucet-metrics.sh` | [deploy/z3/OBSERVABILITY.md](deploy/z3/OBSERVABILITY.md) |

Only caddy is public. Zebra and zallet RPC stay on the private docker
network. Everything docker is `restart: unless-stopped`, so a reboot brings
the containers back without help.

## Start, stop, status

z3 stack (node + wallet), from `/opt/zcash-faucet/deploy/z3-stack`:

```bash
docker compose --env-file .env.testnet up -d      # start
docker compose --env-file .env.testnet down       # stop (never `down -v`)
docker compose --env-file .env.testnet ps         # status
```

Faucet overlay (web app + caddy), from `/opt/zcash-faucet/deploy/z3`:

```bash
FAUCET_DOMAIN=$(cat /etc/faucet-domain) \
  docker compose -f docker-compose.faucet.yml up -d --build   # start / rebuild
docker compose -f docker-compose.faucet.yml down              # stop
docker compose -f docker-compose.faucet.yml ps                # status
```

systemd units, same three verbs everywhere:

```bash
systemctl status|start|stop|restart faucet-watchdog
systemctl status|start|stop|restart zcash-testnet-miner
systemctl list-timers 'faucet-*' 'zsnap-*'      # when the timers fire next
systemctl start faucet-backup                   # run a backup right now
systemctl start zsnap-export                    # run a snapshot right now
```

The watchdog restarts fallen containers within 30 seconds, so if you stop a
container on purpose for a maintenance window, stop the watchdog first and
start it again after.

## Logs

```bash
journalctl -u faucet-watchdog -f          # what the watchdog did and why
journalctl -u zcash-testnet-miner -f      # templates, solves, proposals
journalctl -u zsnap-export -f             # snapshot exports
journalctl -u faucet-backup -f            # backup runs
journalctl -u faucet-metrics --since -1h  # metrics collector
```

Container logs go through docker:

```bash
docker logs --tail 200 -f <container>     # find names with `docker ps`
docker compose -f docker-compose.faucet.yml logs caddy   # from deploy/z3
```

First-boot bring-up on a cloud-init box logs to `/var/log/faucet-deploy.log`.

## Health vs ready

Two endpoints, two different questions. Source of truth is
[src/app/api/health/route.ts](src/app/api/health/route.ts) and
[src/app/api/ready/route.ts](src/app/api/ready/route.ts).

- `GET /api/health` is liveness: is the web process answering at all. It
  does no backend work and is always cheap. The watchdog restarts the web
  container after 3 consecutive misses.
- `GET /api/ready` is readiness: can the faucet serve a drip right now.
  200 when yes, 503 with a JSON `reason` when no. The reason is the most
  upstream blocker, checked in this order:

| Reason | Means |
|---|---|
| `backend unreachable` | the lightwalletd/Zaino read endpoint is not answering |
| `node syncing` | zebra is not at tip yet, normal on first sync or after a restore |
| `wallet balance unknown` | zallet did not return a balance, usually zallet itself is down |
| `below reserve, refilling` | funds are under drip + reserve, faucet needs a refill |

Un-ready is not an outage by itself. First sync and refills are un-ready on
purpose, which is why the watchdog only pages after a 30 minute grace window.

## Redeploy

`deploy/deploy.sh` is re-runnable and skips what is already done, so a
redeploy is a pull plus a re-run:

```bash
cd /opt/zcash-faucet
git pull
NETWORK=testnet FAUCET_DOMAIN=$(cat /etc/faucet-domain) ./deploy/deploy.sh
```

For a web-app-only change, rebuilding the overlay is enough (the compose
`up -d --build` from the start/stop section). Wallet, chain state, ledger and
TLS material all live in named volumes and survive rebuilds.

## Rollback

`redeploy.sh` keeps the previously running image tagged `zcash-faucet:previous`
and can put it back in one command:

```bash
/opt/faucet/redeploy.sh rollback
```

That is also what a failed deploy does on its own, so most of the time the
rollback has already happened by the time you are reading logs. Check what is
running and what is available to go back to:

```bash
/opt/faucet/redeploy.sh status
```

See [REDEPLOY.md](deploy/z3/REDEPLOY.md) for the exit codes. The short version
while you are half awake: **2 means the faucet is serving and the change did
not ship, so it can wait until morning. 1 means the faucet may be down.**

If that image is gone, which happens on a freshly rebuilt box or if the tag
was pruned, build from the last good commit instead:

```bash
cd /opt/zcash-faucet
git log --oneline -10                 # pick the last good sha
git checkout <sha>
cd deploy/z3
FAUCET_DOMAIN=$(cat /etc/faucet-domain) \
  docker compose -f docker-compose.faucet.yml up -d --build
```

Return to main with `git checkout main` and redeploy when fixed. Rolling back
code never touches the volumes, so funds and the rate-limit ledger are safe,
either way.

## Box access: what is exposed, and the ssh resets

```bash
/opt/faucet/audit-access.sh            # what is reachable, and how sshd throttles
/opt/faucet/audit-access.sh --verbose  # also list what matched
```

Read-only, applies nothing. Exit `0` clean, `1` findings, `2` the audit was
incomplete (so it never reports clean on checks it could not run).

### The intended exposure

Public: **22, 80, 443**. Nothing else. The node and wallet RPC are reachable
only on the docker network, and the app's own port is `expose`-only. Anything
else on a wildcard address is a finding, with `18232` (Zebra RPC) and `28232`
(Zallet RPC) the ones that would matter most.

Applying firewall changes, **with a second session already open** so a mistake
is recoverable:

```bash
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable
ufw status                              # confirm before closing that session
```

### Why ssh connections keep resetting

`kex_exchange_identification: Connection closed by remote host` under
connection churn is sshd dropping *unauthenticated* connections, not a network
fault. Two causes, and the audit checks both:

**`ufw limit` on ssh.** That is 6 connections per 30 seconds per source. Ops
loops that open several sessions in parallel exceed it instantly. `ufw allow
OpenSSH` replaces the LIMIT rule.

**`MaxStartups`.** The default is `10:30:100`: random early drop begins at 10
concurrent unauthenticated connections and rises to certain at 100. A script
opening a handful of parallel `ssh` calls, each spending a moment in key
exchange, reaches 10 easily.

The conservative change is to raise the *start* of the drop curve and leave the
ceiling alone:

```
MaxStartups 30:30:100
```

```bash
sshd -t                    # validate the config BEFORE reloading
systemctl reload ssh       # reload, never restart: reload keeps live sessions
```

**Keep a session open while doing this, and verify a new connection succeeds
before closing it.** This box has one door. `reload` rather than `restart`
because a restart drops existing sessions, so a bad config plus a restart is a
box you cannot reach.

If resets continue after both, the next suspects are `fail2ban` banning the
operator IP and per-source rate limiting upstream of the box, neither of which
this audit can see.

## Config drift

The repo is supposed to describe the box. In practice a box accumulates hand
work (a drop-in, an override, a unit copied straight into
`/etc/systemd/system`) and a rebuild silently loses it. Nothing breaks
loudly: the new box comes up, serves, and is quietly missing something only
the person who typed it knows about.

```bash
/opt/faucet/audit-drift.sh            # what is here that the repo does not describe
/opt/faucet/audit-drift.sh --verbose  # also show matches and drop-in contents
```

Exit codes: `0` no drift, `1` drift found, `2` the audit was incomplete. That
last one covers both "could not run at all" and "ran but skipped a check", for
example enablement when there is no `systemctl`. Anything it could not check
is listed under `NOT VERIFIED`, and it never claims the box matches the repo
on the strength of checks it did not perform.

Every finding prints the command that fixes it, so acting on a report is a
paste rather than a puzzle.

It is **read-only and has no `--apply`**. Reconciling the box to the repo
would delete the very hand work the audit exists to surface. The fix for
drift is putting the change into the repo: a hand-installed unit or drop-in
belongs in `deploy/z3/` and in the install docs, an untracked override
belongs in git, and a stale script in `/opt/faucet` means re-copying it or
admitting the box is ahead of review.

Env files are reported as present or absent only. Drop-ins print on an
allowlist: `KEY=<redacted>` lines and nothing else, so a continuation line
carrying `--rpc-password` or a comment carrying a webhook cannot leak. You
learn which key was set by hand, not its value.

## Restore from backup

The backup covers the two things the box cannot regrow: the wallet (keys and
funds) and the rate-limit ledger. Full detail and the gates the restore
enforces are in [deploy/z3/BACKUPS.md](deploy/z3/BACKUPS.md).

```bash
# stop everything holding the databases open
cd /opt/zcash-faucet/deploy/z3 && docker compose -f docker-compose.faucet.yml down
cd /opt/zcash-faucet/deploy/z3-stack && docker compose --env-file .env.testnet down

/opt/faucet/restore-backup.sh                             # newest local archive
/opt/faucet/restore-backup.sh /path/to/archive.tar.gz.gpg # or a specific one

cd /opt/zcash-faucet && ./deploy/deploy.sh                # bring it all back
```

You need `BACKUP_PASSPHRASE` from `/etc/faucet/backup.env` or the team
password store. Without it the archives are noise. Zallet re-scans from the
wallet birthday on first start, so expect a short catch-up before balances
look right.

## Restore from snapshot

Snapshots make chain recovery minutes instead of a day. The whole story,
including hot vs cold exports and the preflight check, is in
[deploy/z3/SNAPSHOTS.md](deploy/z3/SNAPSHOTS.md).

- Fresh box: fill `/etc/zsnap-restore-url` and `/etc/faucet/zsnap.env` in
  `deploy/cloud-init.yaml` before pasting it into the provider. The boot path
  imports the snapshot before zebra starts, automatically.
- Existing box, chain state gone or wiped on purpose:

```bash
/opt/faucet/zsnap-import.sh /var/lib/zsnap/snapshots/latest.tar.zst
```

The import verifies every chunk against the manifest and is atomic, a crash
mid-import cannot leave state zebra would open. It refuses to run over
existing state. Snapshots live in `/var/lib/zsnap/snapshots/` and rotate to
the newest `ZSNAP_KEEP`.

## Miner

The miner works public testnet blocks, and one has survived: block 4208641,
whose coinbase the reserve loop shielded on its own. A dominant miner takes
most races though, so mining is upside rather than a supply you can plan
around, and the wallet is topped up from elsewhere. Do not treat a quiet miner
as an outage, and do not expect an empty faucet to refill itself in any useful
time. The measurement and
the reasoning are in [deploy/z3/MINING.md](deploy/z3/MINING.md), along with
everything else about running it.

```bash
systemctl status zcash-testnet-miner
journalctl -u zcash-testnet-miner -f
```

Mode lives in `/etc/faucet/miner.env`. `MINER_MODE=proposal` (the default the
service ships with) solves and validates through `getblocktemplate
mode=proposal` and submits nothing. That is the safety gate.
`MINER_MODE=submit` goes live, flip it only after a proposal run reports
`proposal VALID`, and coordinate the first live submission. Two more things
worth knowing at 3am: "no solution in this window" in the log is normal, and
a won block pays a transparent coinbase that needs 100 confirmations plus a
shielding step before the faucet balance moves.

## Monitoring and alerts

Alerts push, metrics pull. Both are covered in
[deploy/z3/OBSERVABILITY.md](deploy/z3/OBSERVABILITY.md).

- The watchdog posts to the webhook in `/etc/faucet/watchdog.env`
  (`WATCHDOG_ALERT_URL`, format `slack` or `discord`) when the faucet has
  been un-ready past the grace window, once per episode, and again on
  recovery. It also alerts when it recovers or restarts a container.
- `faucet-metrics.sh` writes `/var/lib/node_exporter/textfile/faucet.prom`
  every 30 seconds: readiness, balance, queue depth, sync state, container
  states. If `faucet_metrics_scrape_timestamp` stops advancing, the collector
  died and the other numbers are stale.

## Faucet is not ready, now what

Ordered by the `/api/ready` reason. Start with the reason itself:

```bash
curl -s "https://$(cat /etc/faucet-domain)/api/ready" | jq
# or hit the app the way the watchdog does (WATCHDOG_FAUCET_URL in
# /etc/faucet/watchdog.env, the overlay does not publish :3000 on the host)
```

1. **No answer at all** (curl fails, or `/api/health` is dead). This is a
   liveness problem, not readiness. The watchdog should already be
   restarting the web container, check `journalctl -u faucet-watchdog` and
   `docker ps`. If caddy is up but the app is not, `docker logs` the faucet
   container. If nothing docker is running, start both stacks per the
   start/stop section.
2. **`backend unreachable`.** The read-side light client endpoint
   (`LIGHTWALLETD_ENDPOINT` in `deploy/z3/faucet.env`, a public Zaino by
   default) is not answering. Check outbound network from the box, and if it
   points at a self-hosted `zaino` container, check that container. Sending
   goes through zallet and does not use this path, so this blocks lookups
   and readiness, not the wallet itself.
3. **`node syncing`.** Zebra is catching up. Normal after a fresh box,
   restore or long downtime, and the watchdog deliberately does not page
   during it. Watch progress in the metrics file or
   `docker logs -f <zebra container>`. Nothing to fix, only to wait, unless
   it is stuck, then look at zebra's logs and disk space.
4. **`wallet balance unknown`.** Zallet did not answer. It is known to exit
   when zebra closes the mempool stream, the watchdog docker-starts it
   again within a sweep. If it is crash-looping instead, read
   `docker logs <zallet container>` and check the RPC auth in
   `z3-stack/config/testnet/zallet.toml` matches `faucet.env`.
5. **`below reserve, refilling`.** Not broken, broke. **Fund the faucet
   address.** That is the fix, not a fallback. Mining lands a block rarely
   enough that it is not the answer at 3am, and even a block won right now
   needs 100 confirmations plus a shielding step before the balance moves, so
   it is never the fast path
   back. Confirm with `curl -s .../api/status`.

If the reason is none of these and the site is dark to users, check
certificates and DNS per [deploy/z3/HTTPS.md](deploy/z3/HTTPS.md), and as a
last resort re-run `deploy/deploy.sh`, which is safe to repeat.
