#!/usr/bin/env bash
# Sends one alert. Shared by watchdog.sh and by every unit's OnFailure hook,
# so configuring one URL covers the whole box. See OBSERVABILITY.md.
set -uo pipefail

# shellcheck disable=SC1091
[ -f /etc/faucet/alerts.env ] && . /etc/faucet/alerts.env
# shellcheck disable=SC1091
[ -f /etc/faucet/watchdog.env ] && . /etc/faucet/watchdog.env

# FAUCET_ALERT_* is the shared name; the older WATCHDOG_ALERT_* still works so
# an existing box keeps alerting after an upgrade.
ALERT_URL="${FAUCET_ALERT_URL:-${WATCHDOG_ALERT_URL:-}}"
ALERT_FORMAT="${FAUCET_ALERT_FORMAT:-${WATCHDOG_ALERT_FORMAT:-slack}}"
PREFIX="${FAUCET_ALERT_PREFIX:-[zcash-faucet]}"
JOURNAL_LINES="${FAUCET_ALERT_JOURNAL_LINES:-15}"

log() { echo "$(date -u +%FT%TZ) alert: $*"; }

# JSON forbids raw control characters and journal output is full of tabs, so a
# sed approximation produces bodies the webhook rejects with no trace. Refuse
# instead: a muted channel is the failure this script exists to prevent.
json_escape() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -Rs '.' | sed 's/^"//; s/"$//'
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$1" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read())[1:-1])'
  else
    log "CANNOT SEND: no jq and no python3, so the alert body cannot be encoded safely." >&2
    log "Install either one. Refusing rather than sending a malformed body the webhook drops silently." >&2
    return 1
  fi
}

send() { # $1 = message text
  local msg body escaped
  escaped="$(json_escape "$PREFIX $1")" || return 4
  msg="$escaped"
  if [ -z "$ALERT_URL" ]; then
    log "NOT SENT (no FAUCET_ALERT_URL configured): $1"
    return 3
  fi
  # Slack and Discord want the same shape under different keys, and each
  # rejects the other's, so the channel type has to be explicit.
  case "$ALERT_FORMAT" in
    discord) body="{\"content\":\"$msg\"}" ;;
    slack)   body="{\"text\":\"$msg\"}" ;;
    *) log "WARNING: unknown FAUCET_ALERT_FORMAT '$ALERT_FORMAT', sending the slack shape (valid: slack, discord)"
       body="{\"text\":\"$msg\"}" ;;
  esac
  if curl -fsS --max-time 10 -H 'content-type: application/json' -d "$body" "$ALERT_URL" >/dev/null 2>&1; then
    log "sent: $1"
    return 0
  fi
  log "POST FAILED to the configured webhook: $1"
  return 1
}

case "${1:-}" in
  --self-test)
    # Exercises the real send path, not a hand-written curl, so it proves the
    # code that will page you actually works.
    # Never interpolate the URL: it is a credential and this line goes to the
    # journal on every setup run.
    log "format=$ALERT_FORMAT url=$([ -n "$ALERT_URL" ] && echo set || echo UNSET)"
    # Capture send's status directly: a failed `if` with no `else` returns 0,
    # which made this exit 0 while printing FAILED.
    send "self-test from $(hostname 2>/dev/null || echo this box), ignore this message"
    rc=$?
    if [ "$rc" = "0" ]; then
      log "SELF-TEST PASSED: check the channel for the message above"
      exit 0
    fi
    [ "$rc" = "3" ] && log "SELF-TEST FAILED: nothing is configured, put FAUCET_ALERT_URL in /etc/faucet/alerts.env" \
                    || log "SELF-TEST FAILED: the webhook rejected the POST, check the URL"
    exit "$rc"
    ;;
  --unit)
    # OnFailure handler. Names the unit and quotes its last log lines, because
    # an alert saying only "something failed" costs an SSH session to act on.
    unit="${2:-unknown.service}"
    tail_lines=""
    command -v journalctl >/dev/null 2>&1 \
      && tail_lines="$(journalctl -u "$unit" -n "$JOURNAL_LINES" --no-pager -o cat 2>/dev/null)"
    send "unit FAILED: $unit${tail_lines:+
$tail_lines}"
    ;;
  "" )
    echo "usage: alert.sh --self-test | --unit <name> | <message>" >&2
    exit 64
    ;;
  *)
    send "$*"
    ;;
esac
