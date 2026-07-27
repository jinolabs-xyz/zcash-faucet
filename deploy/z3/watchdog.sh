#!/usr/bin/env bash
# Stack watchdog for the z3 shielded faucet. Its whole job is that no single
# failure leaves the faucet dark and needing a human on SSH. It does four things
# on a loop and nothing clever:
#
#   1. Reboot survival. Force restart=unless-stopped on every target container,
#      so a box reboot brings the whole stack back with no intervention.
#   2. Dead-container recovery. If a target container has exited or died, start
#      it again. This is the real fix for the wallet fault we kept hitting:
#      zallet exits when zebra closes the mempool stream, and this brings it
#      straight back instead of leaving drips paused.
#   3. Hung web-app recovery. If faucet-web is "running" but /api/health stops
#      answering, restart just that container.
#   4. Honest alerting. If the faucet is not READY (cannot serve a drip) for
#      longer than the grace window, POST to WATCHDOG_ALERT_URL once. It does
#      NOT restart anything for un-readiness alone, because a first sync or a
#      background refill is un-ready on purpose and restarting would only slow
#      it down.
#
# Everything is env-configurable so it survives the container-naming drift
# between the manual faucet-web and the compose overlay. Logs go to stdout so
# journald keeps them. Run it under the systemd unit next to this file.
set -uo pipefail

INTERVAL="${WATCHDOG_INTERVAL:-30}"                 # seconds between sweeps
FAUCET_URL="${WATCHDOG_FAUCET_URL:-http://127.0.0.1:3000}"
FAUCET_FAIL_LIMIT="${WATCHDOG_FAUCET_FAIL_LIMIT:-3}" # consecutive liveness misses before restart
READY_GRACE_SECS="${WATCHDOG_READY_GRACE_SECS:-1800}" # 30 min un-ready before we page
ALERT_URL="${WATCHDOG_ALERT_URL:-}"                 # optional webhook for alerts
ALERT_FORMAT="${WATCHDOG_ALERT_FORMAT:-slack}"      # slack (default) or discord

# Target containers, matched by name substring so exact compose prefixes and the
# hand-run faucet-web container both resolve. Override any of these in the env.
FAUCET_MATCH="${WATCHDOG_FAUCET_MATCH:-faucet-web}"
ZEBRA_MATCH="${WATCHDOG_ZEBRA_MATCH:-zebra}"
ZALLET_MATCH="${WATCHDOG_ZALLET_MATCH:-zallet}"

log() { echo "$(date -u +%FT%TZ) watchdog: $*"; }

# Escapes the two characters that would break the JSON body. Alert text is
# ours, not user input, but a container name with a quote in it should not
# silently drop an alert.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

alert() {
  local msg body
  msg="[zcash-faucet watchdog] $(json_escape "$1")"
  log "ALERT: $1"
  [ -n "$ALERT_URL" ] || return 0
  # Slack and Discord take the same shape with a different key, and both
  # reject the other one, so the channel type has to be explicit.
  case "$ALERT_FORMAT" in
    discord) body="{\"content\":\"$msg\"}" ;;
    slack|*)  body="{\"text\":\"$msg\"}" ;;
  esac
  curl -fsS --max-time 10 -H 'content-type: application/json' \
    -d "$body" "$ALERT_URL" >/dev/null 2>&1 \
    || log "alert webhook POST failed"
}

# First running-or-stopped container id whose name contains $1 (empty if none).
find_container() {
  docker ps -a --filter "name=$1" --format '{{.Names}}' | head -n1
}

# Ensure restart policy is unless-stopped (idempotent, cheap, reboot-safe).
ensure_restart_policy() {
  local name="$1"
  [ -n "$name" ] || return 0
  local pol
  pol="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$name" 2>/dev/null || echo '')"
  if [ "$pol" != "unless-stopped" ] && [ "$pol" != "always" ]; then
    log "setting restart=unless-stopped on $name (was '${pol:-none}')"
    docker update --restart unless-stopped "$name" >/dev/null 2>&1 || log "docker update failed on $name"
  fi
}

# Start a container back up if it is not in the running state.
recover_if_down() {
  local name="$1"
  [ -n "$name" ] || return 0
  local state
  state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo 'missing')"
  case "$state" in
    running) : ;;
    missing) log "container matching '$name' not found yet (stack may still be coming up)";;
    *)
      log "container $name is '$state' — starting it"
      if docker start "$name" >/dev/null 2>&1; then
        alert "recovered $name from state '$state'"
      else
        alert "failed to start $name (state '$state')"
      fi
      ;;
  esac
}

faucet_misses=0
unready_since=0
alerted_unready=0

log "starting: interval=${INTERVAL}s faucet=${FAUCET_URL} ready_grace=${READY_GRACE_SECS}s alert=${ALERT_URL:-none}"

while true; do
  zebra="$(find_container "$ZEBRA_MATCH")"
  zallet="$(find_container "$ZALLET_MATCH")"
  faucet="$(find_container "$FAUCET_MATCH")"

  # 1 + 2: keep restart policy set and bring back anything that fell over.
  for c in "$zebra" "$zallet" "$faucet"; do
    ensure_restart_policy "$c"
    recover_if_down "$c"
  done

  # 3: web-app liveness. Only restart when the container claims to be running
  # but /api/health has stopped answering — a genuine hang, not a cold start.
  if [ -n "$faucet" ] && [ "$(docker inspect -f '{{.State.Status}}' "$faucet" 2>/dev/null)" = "running" ]; then
    if curl -fsS --max-time 5 "$FAUCET_URL/api/health" >/dev/null 2>&1; then
      faucet_misses=0
    else
      faucet_misses=$((faucet_misses + 1))
      log "faucet liveness miss $faucet_misses/$FAUCET_FAIL_LIMIT"
      if [ "$faucet_misses" -ge "$FAUCET_FAIL_LIMIT" ]; then
        log "restarting hung $faucet"
        docker restart "$faucet" >/dev/null 2>&1 && alert "restarted hung faucet-web after $faucet_misses missed health checks"
        faucet_misses=0
      fi
    fi
  fi

  # 4: readiness alerting. Not-ready is normal during first sync / refill, so we
  # only page when it persists past the grace window, and only once per episode.
  now="$(date -u +%s)"
  if curl -fsS --max-time 8 "$FAUCET_URL/api/ready" >/dev/null 2>&1; then
    if [ "$alerted_unready" = "1" ]; then alert "faucet is READY again"; fi
    unready_since=0
    alerted_unready=0
  else
    reason="$(curl -s --max-time 8 "$FAUCET_URL/api/ready" 2>/dev/null | grep -o '"reason":"[^"]*"' | head -n1 | cut -d'"' -f4)"
    [ "$unready_since" = "0" ] && unready_since="$now"
    elapsed=$((now - unready_since))
    if [ "$elapsed" -ge "$READY_GRACE_SECS" ] && [ "$alerted_unready" = "0" ]; then
      alert "faucet not ready for ${elapsed}s (reason: ${reason:-unknown})"
      alerted_unready=1
    fi
  fi

  sleep "$INTERVAL"
done
