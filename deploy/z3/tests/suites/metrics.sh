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
API_PORT="${METRICS_TEST_PORT:-18731}"
"$SCRATCH/stubs/faucet-api-stub" "$API_PORT" >/dev/null 2>&1 &
API_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:$API_PORT/api/status" && break; sleep 0.25; done

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
