# Knowing the faucet is sick before a user tells you

Two independent paths, because they answer different questions.

**Alerts** push: the watchdog already decides when the faucet is genuinely
un-servable and posts to a webhook **when one is configured**. That is the thing
that would wake someone up, and today it wakes nobody: `FAUCET_ALERT_URL` is
unset on the box and #215, which wires it, is deferred. The detection is real and
the delivery is not, so treat every alert path below as writing to a log until
somebody pastes a URL.

**Metrics** pull: `faucet-metrics.sh` writes the faucet's own state to a
Prometheus textfile every 30 seconds, so you can graph balance, queue depth
and sync progress, and answer "when did this start" instead of guessing.

## Alerts: paste one URL

Every unit on the box alerts through one sender, so there is one thing to
configure and one thing to test.

Create an incoming webhook in the channel you actually watch:

- **Slack**: Apps, Incoming Webhooks, Add to Workspace, pick the channel.
- **Discord**: Server Settings, Integrations, Webhooks, New Webhook, Copy
  Webhook URL.

Then paste it into `/etc/faucet/alerts.env`:

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

**The faucet being un-servable.** The watchdog posts once per episode after the
grace window (30 min), and once when it recovers. It deliberately does not page
for un-readiness during a first sync or a refill, because those are un-ready on
purpose.

**Not** anything about disk, balance or drift yet. Those come from the metrics
file below and are alerted by whatever scrapes it.

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
