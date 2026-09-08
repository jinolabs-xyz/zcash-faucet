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
# signal only. Signal has no webhook; FAUCET_ALERT_URL points at a signal-cli-rest-api
# bridge on the box (/v2/send), which needs the linked account's number and a recipient.
# The recipient defaults to the same number, which lands in Note to Self, so one
# variable is enough for the common case. See OBSERVABILITY.md.
SIGNAL_NUMBER="${FAUCET_ALERT_SIGNAL_NUMBER:-}"
SIGNAL_RECIPIENT="${FAUCET_ALERT_SIGNAL_RECIPIENT:-$SIGNAL_NUMBER}"
PREFIX="${FAUCET_ALERT_PREFIX:-[zcash-faucet]}"
JOURNAL_LINES="${FAUCET_ALERT_JOURNAL_LINES:-15}"
# Read from the repo checkout, the same place install-ops reads enabled-units, so the
# tiering is reviewed in a pull request rather than decided by whoever edits the box.
BEST_EFFORT_FILE="${FAUCET_BEST_EFFORT_UNITS:-/opt/zcash-faucet/deploy/z3/best-effort-units}"
# A separate channel when one is configured, so a best-effort failure can be routed to a
# place nobody is paged from. Falls back to the main URL: a quieter LABEL on a loud
# channel still beats losing the message.
BEST_EFFORT_URL="${FAUCET_ALERT_BESTEFFORT_URL:-}"
# ONE MESSAGE PER CAUSE PER HOUR. The day Signal came alive, faucet-metrics.sh was ready to
# post "disk low" every 30 seconds per filesystem, and every 2-minute unit carries
# OnFailure=. A channel that can say the same thing 2,000 times a day is a channel that
# gets muted, and a muted channel is the failure everything in this file exists to
# prevent. So a repeat of the same first line inside the window is counted, not sent, and
# the next one that does go out says how many were held back. 0 turns it off. The state
# dir is created on demand; when it cannot be written, repeats go through, because
# under-alerting is still the worse failure.
#
# ONLY A DELIVERED MESSAGE STARTS THE WINDOW. The first version recorded the cause before
# the POST, so a send that failed (bridge restarting, no encoder) burned the hour for a
# message nobody received, and a disk filling to 0% would have paged exactly zero times.
#
# NOT FOR EPISODE REPORTS. The watchdog's ✅ FIXED and 🚨 NEEDS YOU are already one per
# episode, and their first lines differ, so a cooldown could hold back the NEEDS YOU that
# follows a FIXED and leave a green tick as the channel's last word about a faucet that is
# down. Callers that do their own episode logic pass --now and are never held.
STATE_DIR="${FAUCET_ALERT_STATE_DIR:-/var/lib/faucet-alerts}"
COOLDOWN_RAW="${FAUCET_ALERT_COOLDOWN_SECONDS:-3600}"
COOLDOWN_WARNING=""
case "$COOLDOWN_RAW" in
  ''|*[!0-9]*)
    # "1h" or "3600s" would otherwise read as "not > 0" and turn the cooldown OFF in
    # silence, which hands the flood back to whoever made the typo.
    COOLDOWN=3600
    COOLDOWN_WARNING="FAUCET_ALERT_COOLDOWN_SECONDS='$COOLDOWN_RAW' is not a whole number of seconds; using 3600" ;;
  *) COOLDOWN="$COOLDOWN_RAW" ;;
esac
DEDUP=1

log() { echo "$(date -u +%FT%TZ) alert: $*"; }

# The key is the FIRST LINE, lowercased, with every digit replaced by one '#', so "disk
# low: / has 9% free" and "... 8% free" are one cause and ctaz-rpc@240762-413643-0.service
# and its next instance are one unit, while "40 blocks behind" and "4000 blocks behind"
# stay two: the magnitude survives, the value does not. The journal tail is never part of
# it: it differs every time by construction and would defeat the point. The URL is not
# part of it either; it is a credential and this key names a file.
dedup_key() { # $1 message -> key on stdout, empty when it cannot be computed
  local first
  first="$(printf '%s\n' "$1" | head -n1 | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[0-9]/#/g; s/[[:space:]]+/ /g' 2>/dev/null)" || return 0
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s %s' "$ALERT_FORMAT" "$first" | sha256sum | cut -c1-40
  elif command -v cksum >/dev/null 2>&1; then
    printf '%s %s' "$ALERT_FORMAT" "$first" | cksum | cut -d' ' -f1
  fi
}

# DECIDES, and does not record. 0 = send it (HELD_BACK_NOTE says how many repeats were
# held since the last delivery; DEDUP_FILE names the record for dedup_commit), 1 = hold.
HELD_BACK_NOTE=""
DEDUP_FILE=""
dedup_check() { # $1 message
  HELD_BACK_NOTE=""; DEDUP_FILE=""
  [ "$DEDUP" = 1 ] || return 0
  [ -n "$COOLDOWN_WARNING" ] && log "WARNING: $COOLDOWN_WARNING"
  [ "$COOLDOWN" -gt 0 ] || return 0
  # The cleanup below deletes files, as root, under this path. A misconfiguration must
  # not be able to point it at anything that is not a directory of alert records.
  case "$STATE_DIR" in
    /|/var|/var/lib|/etc|/usr|/home|/root|/opt|/run|/tmp|/srv)
      log "dedup OFF: FAUCET_ALERT_STATE_DIR=$STATE_DIR is a system directory, refusing to keep records there"
      return 0 ;;
  esac
  local key f now last count
  key="$(dedup_key "$1")"; [ -n "$key" ] || return 0
  if ! mkdir -p "$STATE_DIR" 2>/dev/null || [ ! -w "$STATE_DIR" ]; then
    log "dedup OFF: cannot write $STATE_DIR, so repeats of this alert will all be sent"
    return 0
  fi
  f="$STATE_DIR/$key"; now="$(date -u +%s)"
  # OnFailure handlers fire concurrently, so the read-modify-write is serialised.
  exec 9>"$STATE_DIR/.lock"
  if command -v flock >/dev/null 2>&1; then
    flock -w 5 9 || log "WARNING: could not take the cooldown lock in 5s; deciding unserialised"
  fi
  last=0; count=0
  if [ -f "$f" ]; then
    read -r last count < "$f" 2>/dev/null || { last=0; count=0; }
  fi
  [ "$last" -ge 0 ] 2>/dev/null || last=0
  [ "$count" -ge 0 ] 2>/dev/null || count=0
  # A clock stepped backwards would otherwise make an old record look fresh for as long as
  # the step was; an alert must not be held for a day because NTP corrected the box.
  [ "$now" -lt "$last" ] && last=0
  if [ "$last" -gt 0 ] && [ $((now - last)) -lt "$COOLDOWN" ]; then
    printf '%s %s\n' "$last" "$((count + 1))" > "$f"
    exec 9>&-
    log "HELD BACK (same alert within ${COOLDOWN}s, $((count + 1)) so far): $1"
    return 1
  fi
  exec 9>&-
  DEDUP_FILE="$f"
  [ "$count" -gt 0 ] && HELD_BACK_NOTE=" (+$count identical held back in the last $((COOLDOWN / 60)) min)"
  return 0
}

# Called ONLY after the POST succeeded: that is when the window starts. Records for
# causes that stopped firing are never read again; a week is long past any window.
dedup_commit() {
  [ -n "$DEDUP_FILE" ] || return 0
  printf '%s 0\n' "$(date -u +%s)" > "$DEDUP_FILE" 2>/dev/null || true
  find "$STATE_DIR" -maxdepth 1 -type f -name '[0-9a-f]*' -mtime +7 -delete 2>/dev/null
}

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
  if [ -z "$ALERT_URL" ]; then
    log "NOT SENT (no FAUCET_ALERT_URL configured): $1"
    return 3
  fi
  # The two numbers are embedded raw below, so they are checked to be nothing but a
  # plus and digits first. A typo here would otherwise become a malformed body the
  # bridge rejects, which is the silent mute this script exists to prevent.
  if [ "$ALERT_FORMAT" = "signal" ]; then
    if [ -z "$SIGNAL_NUMBER" ]; then
      log "NOT SENT (signal needs FAUCET_ALERT_SIGNAL_NUMBER in /etc/faucet/alerts.env, the linked account in E.164): $1"
      return 3
    fi
    local n
    for n in "$SIGNAL_NUMBER" "$SIGNAL_RECIPIENT"; do
      if ! printf '%s' "$n" | grep -qE '^\+[0-9]{6,15}$'; then
        log "NOT SENT: '$n' is not an E.164 number like +15551234567 (FAUCET_ALERT_SIGNAL_NUMBER / _RECIPIENT)"
        return 3
      fi
    done
  fi
  # Held back is a decision, not a failure: the caller's alert was handled, the journal
  # says so, and the next one through carries the count. So it exits 0.
  dedup_check "$1" || return 0
  escaped="$(json_escape "$PREFIX $1$HELD_BACK_NOTE")" || return 4
  msg="$escaped"
  # Slack and Discord want the same shape under different keys, and each
  # rejects the other's, so the channel type has to be explicit. Signal's bridge
  # wants the message plus who it is from and to.
  case "$ALERT_FORMAT" in
    discord) body="{\"content\":\"$msg\"}" ;;
    slack)   body="{\"text\":\"$msg\"}" ;;
    signal)  body="{\"message\":\"$msg\",\"number\":\"$SIGNAL_NUMBER\",\"recipients\":[\"$SIGNAL_RECIPIENT\"]}" ;;
    *) log "WARNING: unknown FAUCET_ALERT_FORMAT '$ALERT_FORMAT', sending the slack shape (valid: slack, discord, signal)"
       body="{\"text\":\"$msg\"}" ;;
  esac
  if curl -fsS --max-time 10 -H 'content-type: application/json' -d "$body" "$ALERT_URL" >/dev/null 2>&1; then
    dedup_commit
    log "sent: $1$HELD_BACK_NOTE"
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
    log "format=$ALERT_FORMAT url=$([ -n "$ALERT_URL" ] && echo set || echo UNSET) cooldown=${COOLDOWN}s"
    # A self-test is someone at a keyboard asking "does it work". It is never held back.
    DEDUP=0
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
      send "⚠️ best-effort unit failed (feature-net, NOT a faucet outage): $unit${tail_lines:+
$tail_lines}"
    else
      send "🚨 NEEDS YOU: unit FAILED: $unit${tail_lines:+
$tail_lines}"
    fi
    ;;
  --now)
    # For callers that already send one message per episode (the watchdog). Never held.
    shift
    [ -n "${1:-}" ] || { echo "usage: alert.sh --now <message>" >&2; exit 64; }
    DEDUP=0
    send "$*"
    ;;
  "" )
    echo "usage: alert.sh --self-test | --unit <name> | --now <message> | <message>" >&2
    exit 64
    ;;
  *)
    send "$*"
    ;;
esac
