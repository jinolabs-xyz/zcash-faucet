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
# Read from the repo checkout, the same place install-ops reads enabled-units, so the
# tiering is reviewed in a pull request rather than decided by whoever edits the box.
BEST_EFFORT_FILE="${FAUCET_BEST_EFFORT_UNITS:-/opt/zcash-faucet/deploy/z3/best-effort-units}"
# A separate channel when one is configured, so a best-effort failure can be routed to a
# place nobody is paged from. Falls back to the main URL: a quieter LABEL on a loud
# channel still beats losing the message.
BEST_EFFORT_URL="${FAUCET_ALERT_BESTEFFORT_URL:-}"

log() { echo "$(date -u +%FT%TZ) alert: $*"; }

# IS THIS UNIT ALLOWED TO BE QUIET? (#327)
#
# Every failure on this box goes through one handler with one wording, so a Crosslink
# node wobbling reads exactly like the TAZ faucet being down. #327 asked for a tier and
# this is it.
#
# FAILS LOUD. No file, an unreadable file, or a name not listed all mean NOT best-effort,
# because under-alerting is the worse failure of the two. Every ambiguity here resolves
# toward noise.
#
# Instance names arrive as ctaz-rpc@3-172.17.0.2:9.service and the file lists the
# template, so the instance part is stripped before matching. Without that, a template
# could never be tiered and the list would silently do nothing for the one unit type that
# produces the most failures.
is_best_effort() { # $1 unit name
  local unit="$1" template
  [ -r "$BEST_EFFORT_FILE" ] || return 1
  # foo@bar.service -> foo@.service
  # GREEDY to the LAST dot, because systemd instance names contain dots. The real one
  # here is ctaz-rpc@3-172.17.0.2:9.service, and a non-greedy strip cut at the first dot
  # in the IP and produced ctaz-rpc@.17.0.2:9.service - which matches nothing, so the one
  # unit type that generates the most failures could never be tiered. Caught by testing
  # with a realistic instance name rather than a tidy one.
  template="$(printf '%s' "$unit" | sed -E 's/@.*\./@./')"
  grep -vE '^[[:space:]]*(#|$)' "$BEST_EFFORT_FILE" 2>/dev/null \
    | grep -qxF -e "$unit" -e "$template"
}

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
    # One branch per cause. A verification tool that misnames the fault sends
    # someone to debug their Slack URL when the answer is: install jq.
    case "$rc" in
      3) log "SELF-TEST FAILED: nothing is configured, put FAUCET_ALERT_URL in /etc/faucet/alerts.env" ;;
      4) log "SELF-TEST FAILED: no jq and no python3, so the body cannot be encoded. Install either one." ;;
      *) log "SELF-TEST FAILED: the webhook rejected the POST, check the URL" ;;
    esac
    exit "$rc"
    ;;
  --unit)
    # OnFailure handler. Names the unit and quotes its last log lines, because
    # an alert saying only "something failed" costs an SSH session to act on.
    unit="${2:-unknown.service}"
    tail_lines=""
    command -v journalctl >/dev/null 2>&1 \
      && tail_lines="$(journalctl -u "$unit" -n "$JOURNAL_LINES" --no-pager -o cat 2>/dev/null)"
    # THE WORDS DIFFER, and that is the whole mechanism. "unit FAILED" is what a person
    # wakes up for; a best-effort line says what is degraded and what is not, so neither
    # a human nor a routing rule has to already know which units are experimental.
    if is_best_effort "$unit"; then
      [ -n "$BEST_EFFORT_URL" ] && ALERT_URL="$BEST_EFFORT_URL"
      send "best-effort unit failed (feature-net, NOT a faucet outage): $unit${tail_lines:+
$tail_lines}"
    else
      send "unit FAILED: $unit${tail_lines:+
$tail_lines}"
    fi
    ;;
  "" )
    echo "usage: alert.sh --self-test | --unit <name> | <message>" >&2
    exit 64
    ;;
  *)
    send "$*"
    ;;
esac
