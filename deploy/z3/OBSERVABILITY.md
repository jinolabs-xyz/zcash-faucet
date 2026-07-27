# Knowing the faucet is sick before a user tells you

Two independent paths, because they answer different questions.

**Alerts** push: the watchdog already decides when the faucet is genuinely
un-servable and posts to a webhook. That is the thing that wakes someone up.

**Metrics** pull: `faucet-metrics.sh` writes the faucet's own state to a
Prometheus textfile every 30 seconds, so you can graph balance, queue depth
and sync progress, and answer "when did this start" instead of guessing.

## Alerts to a real channel

The watchdog posts once per episode when the faucet has been un-ready past
its grace window (30 minutes by default), and once more when it recovers. It
deliberately does not page for un-readiness alone during a first sync or a
refill, because those are un-ready on purpose.

Create an incoming webhook in the channel you actually watch:

- **Slack**: Apps → Incoming Webhooks → Add to Workspace, pick the channel,
  copy the `https://hooks.slack.com/services/...` URL.
- **Discord**: Server Settings → Integrations → Webhooks → New Webhook, pick
  the channel, Copy Webhook URL.

Then, in `/etc/faucet/watchdog.env`:

```
WATCHDOG_ALERT_URL=https://hooks.slack.com/services/T000/B000/xxxx
WATCHDOG_ALERT_FORMAT=slack        # or: discord
```

```bash
systemctl restart faucet-watchdog
journalctl -u faucet-watchdog -f     # "starting: ... alert=https://..."
```

The two services want different keys in the body (`text` for Slack,
`content` for Discord) and each rejects the other's, so the format is
explicit rather than guessed. Anything else that accepts a JSON POST works
with the Slack shape.

Keep the file root-owned and `chmod 600`: a webhook URL is a credential,
anyone holding it can post into your channel.

Test it end to end before trusting it:

```bash
curl -fsS -H 'content-type: application/json' \
  -d '{"text":"[zcash-faucet watchdog] test alert, ignore"}' "$WATCHDOG_ALERT_URL"
```

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
