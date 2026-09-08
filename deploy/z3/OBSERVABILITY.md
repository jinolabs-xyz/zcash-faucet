# Knowing the faucet is sick before a user tells you

Two independent paths, because they answer different questions.

**Alerts** push: the watchdog decides when the faucet is genuinely un-servable
and `alert.sh` delivers it to the channel in `/etc/faucet/alerts.env`. The
reference box pages **Signal** through a bridge on the box (below). Until a
channel is configured the detection is real and the delivery is not: every alert
path writes to the journal and nobody hears it, which is how two outages on
2026-09-07 each went unnoticed for over an hour.

**Metrics** pull: `faucet-metrics.sh` writes the faucet's own state to a
Prometheus textfile every 30 seconds, so you can graph balance, queue depth
and sync progress, and answer "when did this start" instead of guessing.

## Alerts: one file, one self-test

Every unit on the box alerts through one sender, `alert.sh`, so there is one
file to configure and one command to test. The reference box pages Signal;
Slack and Discord webhooks are also supported, below.

### Signal, through a bridge on the box

Signal has no webhooks. The way in is `signal-cli-rest-api`, one container on
the box that exposes a local HTTP API the sender posts to. It links to your
existing Signal account as a secondary device, the way Signal Desktop does, so
there is no second phone number, and alerts land in **Note to Self** with a
normal notification.

```bash
docker run -d --name signal-api --restart unless-stopped \
  -p 127.0.0.1:8081:8080 \
  -v /var/lib/signal-api:/home/.local/share/signal-cli \
  -e MODE=json-rpc bbernhard/signal-cli-rest-api
```

Link it once. From your laptop, `ssh -L 8081:127.0.0.1:8081 root@<box>`, open
`http://127.0.0.1:8081/v1/qrcodelink?device_name=faucet-box` in a browser, scan
the QR with Signal (Settings, Linked devices, Link new device), then
`docker restart signal-api` so the daemon picks up the account. Put this in
`/etc/faucet/alerts.env`:

```
FAUCET_ALERT_URL=http://127.0.0.1:8081/v2/send
FAUCET_ALERT_FORMAT=signal
FAUCET_ALERT_SIGNAL_NUMBER=+15551234567      # the account you linked, E.164
# FAUCET_ALERT_SIGNAL_RECIPIENT=+1555...     # optional, defaults to the number above
```

The bridge is bound to loopback on purpose: it can send as you, so it must never
be reachable from outside the box. One limit: the bridge lives on the box, so the
off-box live-smoke page, the check that still fires when the whole box is dead,
cannot use it. That one emails, and can take a Slack or Discord webhook.

### Slack or Discord instead

Create an incoming webhook in the channel you watch (Slack: Apps, Incoming
Webhooks; Discord: Server Settings, Integrations, Webhooks) and use it as the URL:

```
FAUCET_ALERT_URL=https://hooks.slack.com/services/T000/B000/xxxx
FAUCET_ALERT_FORMAT=slack        # or: discord
```

```bash
cp alert.sh /opt/faucet/ && chmod +x /opt/faucet/alert.sh
cp faucet-alert@.service /etc/systemd/system/
chmod 600 /etc/faucet/alerts.env    # a webhook URL is a credential
systemctl daemon-reload
/opt/faucet/alert.sh --self-test
```

The self-test posts through the **same code path** that will page you, so a
pass means the thing that matters works. A hand-written `curl` only proves the
webhook exists. It exits 0 on success, 3 when nothing is configured, and 1 when
the webhook rejects the POST, and it says which.

`WATCHDOG_ALERT_URL` from earlier installs still works, so an upgrade cannot
silently mute the box.

### The watchdog has to be able to see the faucet, or its clock is wrong

The watchdog's 30-minute "not ready" page and its hung-app restart both probe
`WATCHDOG_FAUCET_URL`, default `http://127.0.0.1:3000`, and look for a container
whose name contains `WATCHDOG_FAUCET_MATCH`, default `faucet-web`. Under the compose
overlay **neither default holds**: the app publishes no host port, so the probe
answers nothing forever, and the container is `zcash-faucet-faucet-1`, so the match
finds nothing. 2026-09-07 the faucet was down for over an hour, twice, and the
readiness page never fired for the right reason. Set both in
`/etc/faucet/watchdog.env` (the unit loads it) and restart the watchdog:

```
WATCHDOG_FAUCET_URL=https://zcashfaucet.jinolabs.xyz   # through caddy, what users hit
WATCHDOG_FAUCET_MATCH=zcash-faucet-faucet
```

Probing the public URL from the box is deliberate: it exercises the same path a
user does, so "ready" means ready for them, not just for localhost.

**Rotate the webhook if you ran a self-test before this fix.** An earlier
version logged the full URL, so the token may be sitting in the journal.
Deleting the entry and creating a new webhook is the only reliable remedy.

Alerting needs `jq` or `python3` to encode the body. Without either it
refuses and says so, rather than posting something the webhook silently
drops.

### What alerts, and what does not

**Any unit failing.** Each unit carries
`OnFailure=faucet-alert@%n.service`, so a failed backup, export, metrics run,
watchdog or miner posts the unit name and its last 15 journal lines. Before
this, a timer could fail every cycle in silence, which is exactly how
`zsnap-export` sat producing nothing.

**Two kinds of message, and the first word says which.** `✅ FIXED:` is one
report per resolved episode, sent only once the watchdog has *seen* the recovery
(the tip moving again, the wallet running clean, the miner templating), naming
what was wrong, what fixed it and how many attempts it took. `🚨 NEEDS YOU:` is
the page: a heal budget exhausted, a container crash-looping, a unit failing, or
the faucet not ready past the grace window (30 min). The attempts in between are
journal lines, not messages, so a phone sees one line per problem rather than a
running commentary, and a self-heal is still never silent.

**The faucet being un-servable.** The watchdog pages once per episode after the
grace window and reports once when it recovers. It deliberately does not page
for un-readiness during a first sync or a refill, because those are un-ready on
purpose.

**Disk.** `faucet-metrics.sh` pages `🚨 NEEDS YOU: disk low` when a watched
filesystem drops under `METRICS_DISK_FLOOR_PCT` (10%). `faucet-prune.timer` runs `prune.sh` daily at 04:10 UTC (plus up to
ten minutes of jitter) to remove
Docker build cache and dangling layers, which nothing else does. It never
touches volumes, containers or any tagged image; unused tags are listed in its
journal as information. A prune that fails is a failed unit, so it pages.
The build-cache reserve is `PRUNE_KEEP_BUILD_CACHE` (20GB, measured: one
build leaves ~2.4 GB, a day of deploys ~7 GB) in the optional
`/etc/faucet/prune.env`; `PRUNE_DRY_RUN=1 /opt/faucet/prune.sh` says what a
run would do without doing it. Balance
and drift are in the metrics file below and alerted by whatever scrapes it.

**Once per cause per hour.** `alert.sh` remembers the first line of every
message it has *delivered*, with each digit blanked, under
`/var/lib/faucet-alerts`. A repeat inside `FAUCET_ALERT_COOLDOWN_SECONDS`
(3600) is counted in its output as `HELD BACK` and not sent; the next one that
goes out ends with `(+N identical held back in the last 60 min)`. A send that
fails starts no window, so the next repeat is tried again. Two instances of the
same template unit are one cause; `9% free` and `8% free` are one cause;
`40 behind` and `4000 behind` are two. The watchdog's `✅ FIXED` and
`🚨 NEEDS YOU` are already one per episode and pass `--now`, so a NEEDS YOU
is never held behind the FIXED before it. `--self-test` is never held. A value
that is not a whole number falls back to 3600 with a `WARNING` in the journal;
`0` turns it off.

## Metrics

```bash
cd /opt/zcash-faucet/deploy/z3
cp faucet-metrics.sh /opt/faucet/ && chmod +x /opt/faucet/faucet-metrics.sh
cp faucet-metrics.service faucet-metrics.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now faucet-metrics.timer
cat /var/lib/node_exporter/textfile/faucet.prom
```

What lands in the file:

| Metric | Means |
|---|---|
| `faucet_up` | the web app answered its readiness probe at all |
| `faucet_ready` | it can serve a drip right now |
| `faucet_balance_taz` | spendable balance |
| `faucet_empty` | nothing left to send |
| `faucet_queue_depth` | sends waiting in the serialized queue |
| `faucet_node_ready` / `faucet_node_sync_percent` / `faucet_node_height` | node sync state |
| `faucet_container_up` / `faucet_zallet_container_up` / `faucet_web_container_up` | container states |
| `faucet_metrics_scrape_timestamp` | when this file was written |

`faucet_up 0` and a missing `faucet_ready` mean the app said *nothing*, which
is a different problem from `faucet_up 1, faucet_ready 0`, where it answered
and told you why it cannot serve. The script never invents a readiness value
it did not get.

Watch `faucet_metrics_scrape_timestamp` going stale: if it stops advancing,
the timer died and every other number on this page is a lie.

### Getting them into Prometheus

The file is written in the node_exporter textfile format, so if you run
node_exporter, point it at the directory and you are done:

```
node_exporter --collector.textfile.directory=/var/lib/node_exporter/textfile
```

If you would rather use the Grafana and Prometheus that z3 ships, start them
with `docker compose --env-file .env.testnet --profile monitoring up -d` in
the z3 directory and add the same textfile path.

Nothing is exposed over HTTP on purpose. Scraping happens from inside the
box, so no new port is published to the internet and the wallet balance does
not appear on a public endpoint that does not already carry it.

### Alerts worth having, once the numbers are flowing

- `faucet_up == 0` for 5 minutes: the web app is not answering, and the
  watchdog should already have restarted it. If both are true, look at the
  box.
- `faucet_ready == 0` for 30 minutes: matches what the watchdog pages on. A
  first sync or a refill trips this legitimately, hence the window.
- `faucet_empty == 1`: the faucet is out of funds. Not urgent at 3am, but it
  is dark to users until someone refills or the miner lands a block.
- `time() - faucet_metrics_scrape_timestamp > 300`: the collector itself
  stopped, so trust nothing else here.
