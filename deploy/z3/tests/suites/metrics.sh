# shellcheck shell=bash
# faucet-metrics.sh: scrapes the app's own endpoints into a Prometheus
# textfile. A real python http server serves canned /api/ready and
# /api/status; docker is stubbed for container state.

METRICS_SH="$REPO/deploy/z3/faucet-metrics.sh"

metrics_env() {
  fresh_env
  # fresh_env puts the whole stubs dir on PATH, including the curl stub that
  # fakes /ready for the zsnap gate tests. These tests need the REAL curl
  # (they talk to an actual server) but still want the docker stub, so build
  # a bin dir holding just docker.
  mkdir -p "$T/bin" "$T/textfile"
  ln -sf "$SCRATCH/stubs/docker" "$T/bin/docker"
  export PATH="$T/bin:$BASE_PATH"
  export METRICS_FILE="$T/textfile/faucet.prom"
  export METRICS_FAUCET_URL="http://127.0.0.1:$API_PORT"
}
# One server for the whole suite, torn down at the end.
#
# The readiness probe below runs at suite TOP LEVEL, before any metrics_env call, so it
# used to inherit whatever PATH the PREVIOUS suite left behind. That is a real dependency
# on suite order: the deploy suite leaves its own stub dir first on PATH, and when a `curl`
# stub was added there this probe started answering success instantly. The server was then
# still coming up, the scrape read nothing, and eight value assertions failed while "run
# exits 0" and "textfile created" both passed. A stub answering a question it should never
# have been asked.
#
# So the probe uses the REAL curl explicitly, by absolute path, and does not care what is
# on PATH at all.
API_PORT="${METRICS_TEST_PORT:-18731}"
REAL_CURL="$(PATH="$BASE_PATH" command -v curl)"
"$SCRATCH/stubs/faucet-api-stub" "$API_PORT" >/dev/null 2>&1 &
API_PID=$!
up=0
for _ in $(seq 1 40); do
  if "$REAL_CURL" -sf -o /dev/null "http://127.0.0.1:$API_PORT/api/status"; then up=1; break; fi
  sleep 0.25
done
# Never proceed silently on a server that never came up: every value assertion below would
# fail for a reason that has nothing to do with the code under test.
[ "$up" = 1 ] || { echo "REFUSING: the metrics fixture's API stub never came up on port $API_PORT" >&2; exit 1; }

echo "== metrics: scrapes the live endpoints into a textfile"
metrics_env
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
echo exited  > "$STUB_CONTAINERS/faucet-web"
bash "$METRICS_SH" > "$T/m1.log" 2>&1
check "metrics run exits 0" "[ $? -eq 0 ]"
check "textfile created" "[ -f '$METRICS_FILE' ]"
check "app reachable is faucet_up 1" "grep -qx 'faucet_up 1' '$METRICS_FILE'"
# /api/ready answers 503 with ready:false, which is an answer, not an outage.
check "not-ready is recorded as faucet_ready 0" "grep -qx 'faucet_ready 0' '$METRICS_FILE'"
check "balance comes through" "grep -qx 'faucet_balance_taz 3.5' '$METRICS_FILE'"
check "queue depth comes through" "grep -qx 'faucet_queue_depth 2' '$METRICS_FILE'"
check "empty=false becomes 0" "grep -qx 'faucet_empty 0' '$METRICS_FILE'"
# The nested node object, not the top-level "ready" that means something else.
check "nested node.ready read correctly" "grep -qx 'faucet_node_ready 1' '$METRICS_FILE'"
check "nested node.syncPercent read correctly" "grep -qx 'faucet_node_sync_percent 99.98' '$METRICS_FILE'"
check "nested node.height read correctly" "grep -qx 'faucet_node_height 4204726' '$METRICS_FILE'"
check "running container reported up" "grep -qx 'faucet_container_up 1' '$METRICS_FILE'"
check "exited container reported down" "grep -qx 'faucet_web_container_up 0' '$METRICS_FILE'"
check "every metric has HELP and TYPE" "[ \"\$(grep -c '^# HELP' '$METRICS_FILE')\" = \"\$(grep -c '^# TYPE' '$METRICS_FILE')\" ]"
check "no temp file left behind" "! ls '$T/textfile/'faucet.prom.?????? >/dev/null 2>&1"

echo "== metrics: app unreachable is distinguishable from app saying no"
metrics_env
export METRICS_FAUCET_URL="http://127.0.0.1:1"    # nothing listens here
bash "$METRICS_SH" > "$T/m2.log" 2>&1
check "still exits 0 so the timer stays green" "[ $? -eq 0 ]"
check "faucet_up 0 when the app answers nothing" "grep -qx 'faucet_up 0' '$METRICS_FILE'"
check "no invented readiness value" "! grep -q '^faucet_ready ' '$METRICS_FILE'"
check "container metrics still emitted" "grep -q '^faucet_container_up ' '$METRICS_FILE'"

echo "== metrics: rewrites stay complete and readable"
metrics_env
bash "$METRICS_SH" > /dev/null 2>&1
check "first write produced content" "[ -s '$METRICS_FILE' ]"
bash "$METRICS_SH" > /dev/null 2>&1
check "rewrite leaves a complete file" "grep -q 'faucet_metrics_scrape_timestamp' '$METRICS_FILE'"
check "file is world-readable for the scraper" "[ \"\$(stat -c %a '$METRICS_FILE')\" = '644' ]"

kill "$API_PID" 2>/dev/null

echo "== metrics: disk gauges per filesystem, and a floor that alerts"
metrics_env
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
export METRICS_DISK_PATHS="$T"
export METRICS_DISK_FLOOR_PCT=0            # nothing is below a 0% floor
bash "$METRICS_SH" > "$T/disk.log" 2>&1
check "free bytes gauge emitted with a path label" "grep -q 'faucet_disk_free_bytes{path=\"$T\"} [0-9]' '$METRICS_FILE'"
check "free percent gauge emitted" "grep -q 'faucet_disk_free_percent{path=\"$T\"} [0-9]' '$METRICS_FILE'"
check "not below floor at 0%" "grep -q 'faucet_disk_below_floor{path=\"$T\"} 0' '$METRICS_FILE'"
check "no alert sent when healthy" "! grep -q 'DISK LOW' '$T/disk.log'"

# A 101% floor is below-floor by construction, so the alert path runs without
# needing to actually fill a disk.
metrics_env
export METRICS_DISK_PATHS="$T" METRICS_DISK_FLOOR_PCT=101
printf '#!/usr/bin/env bash\necho "ALERTED: $*" >> %q\n' "$T/alerts.log" > "$T/fake-alert.sh"
chmod +x "$T/fake-alert.sh"; export METRICS_ALERT_SH="$T/fake-alert.sh"
bash "$METRICS_SH" > "$T/disk2.log" 2>&1
check "below-floor gauge is 1" "grep -q 'faucet_disk_below_floor{path=\"$T\"} 1' '$METRICS_FILE'"
check "logs the shortfall with both numbers" "grep -qE 'DISK LOW: .* has [0-9]+% free, floor is 101%' '$T/disk2.log'"
check "pages through the shared sender" "grep -q 'ALERTED: disk low' '$T/alerts.log'"
check "the alert names the consequence" "grep -q 'snapshots and backups will start failing' '$T/alerts.log'"

echo "== metrics: a nonexistent disk path is skipped, not reported as 0 free"
metrics_env
export METRICS_DISK_PATHS="$T/definitely-not-here"
bash "$METRICS_SH" > /dev/null 2>&1
check "no gauge invented for a missing path" "! grep -q 'definitely-not-here' '$METRICS_FILE'"

echo "== metrics: the file only ever contains valid Prometheus lines"
# A log line leaking into the textfile can make node_exporter reject all of it,
# and the disk warning did exactly that until it was sent to stderr.
metrics_env
export METRICS_DISK_PATHS="$T" METRICS_DISK_FLOOR_PCT=101
printf '#!/usr/bin/env bash\nexit 0\n' > "$T/fake-alert.sh"; chmod +x "$T/fake-alert.sh"
export METRICS_ALERT_SH="$T/fake-alert.sh"
bash "$METRICS_SH" > "$T/valid.log" 2>&1
check "warning appears in the log, not the metrics file" "grep -q 'DISK LOW' '$T/valid.log' && ! grep -q 'DISK LOW' '$METRICS_FILE'"
check "every line is a comment or a metric" "! grep -vE '^(#|[a-z_]+(\{[^}]*\})? -?[0-9.]+$)' '$METRICS_FILE'"
