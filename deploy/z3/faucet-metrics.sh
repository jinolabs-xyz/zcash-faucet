#!/usr/bin/env bash
# Turns the faucet's own endpoints into Prometheus metrics.
#
# The app already answers the questions worth alerting on (/api/ready says
# whether a drip can be served and why not, /api/status carries balance,
# queue depth and sync progress), but only as JSON to whoever asks. This
# writes them as a Prometheus textfile so they can be graphed and alerted on
# without adding a metrics dependency to the app or another daemon to the box.
#
# Output goes to $METRICS_FILE, written atomically (temp file then rename) so
# a scrape never reads a half-written file. Point node_exporter's
# --collector.textfile.directory at that directory, or just read the file:
#
#   watch -n5 cat /var/lib/node_exporter/textfile/faucet.prom
#
# Run it under faucet-metrics.timer. Logs go to stdout for journald.
#
# Deliberately not exposed over HTTP. Scraping is a pull from inside the box
# (node_exporter, or a sidecar), so nothing new gets published to the
# internet, and the wallet balance stays off a public endpoint that does not
# already carry it.
set -uo pipefail

FAUCET_URL="${METRICS_FAUCET_URL:-http://127.0.0.1:3000}"
METRICS_FILE="${METRICS_FILE:-/var/lib/node_exporter/textfile/faucet.prom}"
CURL_TIMEOUT="${METRICS_CURL_TIMEOUT:-8}"
# Container names are matched by substring, same convention as watchdog.sh.
ZEBRA_MATCH="${METRICS_ZEBRA_MATCH:-zebra}"
ZALLET_MATCH="${METRICS_ZALLET_MATCH:-zallet}"
FAUCET_MATCH="${METRICS_FAUCET_MATCH:-faucet-web}"
# Filesystems worth watching, and the floor under which the box is in trouble.
METRICS_DISK_PATHS="${METRICS_DISK_PATHS:-/ /var/lib/zsnap /var/lib/faucet-backups}"
METRICS_DISK_FLOOR_PCT="${METRICS_DISK_FLOOR_PCT:-10}"

log() { echo "$(date -u +%FT%TZ) faucet-metrics: $*"; }
# Shared sender, so a low-disk warning pages the same channel as everything else.
ALERT_SH="${METRICS_ALERT_SH:-$(dirname "$0")/alert.sh}"

# Pulls a numeric or boolean field out of a JSON blob without needing jq,
# which is not installed on a stock box. Prints nothing when the field is
# absent or null, and the caller decides what that means.
jfield() { # $1 json, $2 key
  printf '%s' "$1" \
    | grep -o "\"$2\":[[:space:]]*\(true\|false\|null\|-\?[0-9.]\+\)" \
    | head -n1 | sed 's/.*:[[:space:]]*//'
}
# Pulls a nested object out by key, e.g. the "node":{...} blob, so its fields
# can be read without confusing them with same-named top-level keys ("ready"
# exists at both levels and means different things).
jobject() { # $1 json, $2 key
  printf '%s' "$1" | sed -n "s/.*\"$2\":[[:space:]]*{\([^{}]*\)}.*/\1/p"
}
# Booleans become 1/0 so Prometheus can graph them; anything else drops out.
as_gauge() {
  case "$1" in
    true) echo 1 ;;
    false) echo 0 ;;
    null|"") echo "" ;;
    *) echo "$1" ;;
  esac
}
emit() { # $1 name, $2 help, $3 type, $4 value (skipped when empty)
  [ -n "$4" ] || return 0
  printf '# HELP %s %s\n# TYPE %s %s\n%s %s\n' "$1" "$2" "$1" "$3" "$1" "$4"
}
container_up() { # 1 when a container matching $1 is running, else 0
  local name state
  name="$(docker ps -a --filter "name=$1" --format '{{.Names}}' 2>/dev/null | head -n1)"
  [ -n "$name" ] || { echo 0; return; }
  state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
  [ "$state" = "running" ] && echo 1 || echo 0
}

mkdir -p "$(dirname "$METRICS_FILE")"
tmp="$(mktemp "${METRICS_FILE}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

now="$(date -u +%s)"

# /api/ready is the one that decides whether anyone should be paged: 200 when
# a drip can be served, 503 with the most upstream reason when not.
ready_body="$(curl -fsS --max-time "$CURL_TIMEOUT" "$FAUCET_URL/api/ready" 2>/dev/null)"
ready_code="$?"
if [ "$ready_code" -ne 0 ]; then
  # A 503 is a real answer, not a failure to reach the app, so read the body
  # even when curl reports the HTTP error.
  ready_body="$(curl -sS --max-time "$CURL_TIMEOUT" "$FAUCET_URL/api/ready" 2>/dev/null)"
fi
status_body="$(curl -fsS --max-time "$CURL_TIMEOUT" "$FAUCET_URL/api/status" 2>/dev/null)"

{
  if [ -n "$ready_body" ]; then
    emit faucet_up "1 when the faucet app answered its readiness probe." gauge 1
    emit faucet_ready "1 when the faucet can serve a drip right now." gauge \
      "$(as_gauge "$(jfield "$ready_body" ready)")"
    emit faucet_node_ready "1 when the node reports itself synced." gauge \
      "$(as_gauge "$(jfield "$(jobject "$ready_body" node)" ready)")"
  else
    # Distinguish "the app said no" from "the app said nothing". Only the
    # second one means the web process itself is the problem.
    emit faucet_up "1 when the faucet app answered its readiness probe." gauge 0
  fi

  if [ -n "$status_body" ]; then
    emit faucet_balance_taz "Spendable faucet balance in TAZ." gauge \
      "$(as_gauge "$(jfield "$status_body" balanceTaz)")"
    emit faucet_empty "1 when the faucet has nothing left to send." gauge \
      "$(as_gauge "$(jfield "$status_body" empty)")"
    emit faucet_queue_depth "Sends waiting in the serialized send queue." gauge \
      "$(as_gauge "$(jfield "$status_body" queueDepth)")"
    node_obj="$(jobject "$status_body" node)"
    emit faucet_node_sync_percent "Node sync progress, 0-100." gauge \
      "$(as_gauge "$(jfield "$node_obj" syncPercent)")"
    emit faucet_node_height "Block height the node has verified." gauge \
      "$(as_gauge "$(jfield "$node_obj" height)")"
  fi

  emit faucet_container_up "1 when the zebra container is running." gauge "$(container_up "$ZEBRA_MATCH")"
  emit faucet_zallet_container_up "1 when the zallet container is running." gauge "$(container_up "$ZALLET_MATCH")"
  emit faucet_web_container_up "1 when the faucet web container is running." gauge "$(container_up "$FAUCET_MATCH")"
  # Disk. A full disk stops exports, backups and the chain at once, so this is
  # reported per filesystem rather than as one number.
  for path in $METRICS_DISK_PATHS; do
    [ -d "$path" ] || continue
    read -r fs_free fs_size <<EOF
$(df -Pk "$path" | awk 'NR==2 {print $4, $2}')
EOF
    [ -n "${fs_size:-}" ] && [ "$fs_size" -gt 0 ] || continue
    free_pct=$((fs_free * 100 / fs_size))
    emit "faucet_disk_free_bytes{path=\"$path\"}" "Free bytes on the filesystem holding $path." gauge "$((fs_free * 1024))"
    emit "faucet_disk_free_percent{path=\"$path\"}" "Free percent on the filesystem holding $path." gauge "$free_pct"
    emit "faucet_disk_below_floor{path=\"$path\"}" "1 when free percent is under METRICS_DISK_FLOOR_PCT." gauge \
      "$([ "$free_pct" -lt "$METRICS_DISK_FLOOR_PCT" ] && echo 1 || echo 0)"
    if [ "$free_pct" -lt "$METRICS_DISK_FLOOR_PCT" ]; then
      log "DISK LOW: $path has ${free_pct}% free, floor is ${METRICS_DISK_FLOOR_PCT}%" >&2
      [ -x "$ALERT_SH" ] && "$ALERT_SH" "disk low: $path has ${free_pct}% free (floor ${METRICS_DISK_FLOOR_PCT}%), snapshots and backups will start failing" >/dev/null 2>&1
    fi
  done

  emit faucet_metrics_scrape_timestamp "Unix time this file was written." gauge "$now"
} > "$tmp"

# Rename is atomic on the same filesystem, so a scrape sees either the old
# file or the new one, never a partial write.
mv "$tmp" "$METRICS_FILE"
chmod 644 "$METRICS_FILE"
log "wrote $(grep -c '^faucet_' "$METRICS_FILE") metrics to $METRICS_FILE"
