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
DEDUP=1

log() { echo "$(date -u +%FT%TZ) alert: $*"; }

# Validated ONCE, here, and the warning prints on every run including --self-test, which is
# the command an operator runs to check exactly this. "1h" or "3600s" would otherwise read
# as "not > 0" and turn the cooldown OFF in silence; a value too big for `test` would print
# a bash error and do the same. One day is the cap: past that it is not a cooldown.
case "$COOLDOWN_RAW" in
  ''|*[!0-9]*)
    COOLDOWN=3600
    log "WARNING: FAUCET_ALERT_COOLDOWN_SECONDS='$COOLDOWN_RAW' is not a whole number of seconds; using 3600" ;;
  *)
    # Leading zeros first, or "0003600" reads as seven digits and "more than a day".
    COOLDOWN_NUM="$(printf '%s' "$COOLDOWN_RAW" | sed 's/^0*//')"; COOLDOWN_NUM="${COOLDOWN_NUM:-0}"
    if [ "${#COOLDOWN_NUM}" -gt 5 ] || [ "$COOLDOWN_NUM" -gt 86400 ]; then
      COOLDOWN=86400
      log "WARNING: FAUCET_ALERT_COOLDOWN_SECONDS=$COOLDOWN_RAW is more than a day; using 86400"
    else
      COOLDOWN="$COOLDOWN_NUM"
    fi ;;
esac

# The key is the FIRST LINE, lowercased, with every digit replaced by one '#', so "disk
# low: / has 9% free" and "... 8% free" are one cause and ctaz-rpc@240762-413643-0.service
# and its next instance are one unit, while "40 blocks behind" and "4000 blocks behind"
# stay two: the magnitude survives, the value does not. The journal tail is never part of
# it: it differs every time by construction and would defeat the point. The URL is not
# part of it either; it is a credential and this key names a file.
# DEDUP_SUBJECT, when set, is the key's text instead of the message's first line. --unit
# sets it to the unit's TEMPLATE name: instance ids like @10-3385354-0 and
# @100000-3396810-0 differ in digit count, so blanking digits alone left them as
# separate causes and five instances of one broker paged five times.
DEDUP_SUBJECT=""
dedup_key() { # $1 message -> key on stdout, empty when it cannot be computed
  local first
  first="$(printf '%s\n' "${DEDUP_SUBJECT:-$1}" | head -n1 | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[0-9]/#/g; s/[[:space:]]+/ /g' 2>/dev/null)" || return 0
  # ALWAYS 40 hex characters, whichever tool made it, so the weekly sweep can be anchored to
  # exactly that shape and nothing else in the directory can ever match it.
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s %s' "$ALERT_FORMAT" "$first" | sha256sum | cut -c1-40
  elif command -v cksum >/dev/null 2>&1; then
    printf '%040d' "$(printf '%s %s' "$ALERT_FORMAT" "$first" | cksum | cut -d' ' -f1)"
  fi
}

# THE STATE DIR MUST BE OURS. dedup_commit deletes files under it, as root, and a denylist
# of system paths was bypassed by "/etc/" with a trailing slash in review: that run deleted
# /etc/fstab. So the rule is ownership, not a list of names: records live only in a
# directory this script created (marked with .faucet-alerts) or found empty. An existing
# directory with other people's files in it gets no marker, no records, no find, and a
# journal line saying so. Fails toward noise, like everything else here.
dedup_dir_ok() {
  local real entry
  real="$(realpath -m -- "$STATE_DIR" 2>/dev/null)" || real="$STATE_DIR"
  case "$real" in /) return 1 ;; esac
  if [ -e "$real/.faucet-alerts" ]; then
    # Marked as ours, but still has to be writable, or the run would print raw
    # "Permission denied" lines instead of the designed dedup OFF.
    [ -w "$real" ] || return 1
    STATE_DIR="$real"; return 0
  fi
  if [ -d "$real" ]; then
    # Empty, OR holding nothing but our own files: two callers adopting an empty directory
    # at the same instant means the second sees the first's marker before its own
    # `-e` check ran, and must not conclude the directory belongs to someone else.
    for entry in "$real"/* "$real"/.[!.]*; do
      [ -e "$entry" ] || continue
      entry="${entry##*/}"
      case "$entry" in
        .faucet-alerts|.lock) ;;
        .lock.*) k="${entry#.lock.}"; [ "${#k}" = 40 ] && [ -z "${k//[0-9a-f]/}" ] || return 1 ;;
        *) [ "${#entry}" = 40 ] && [ -z "${entry//[0-9a-f]/}" ] || return 1 ;;
      esac
    done
  fi
  mkdir -p -- "$real" 2>/dev/null && : > "$real/.faucet-alerts" 2>/dev/null && [ -w "$real" ] || return 1
  STATE_DIR="$real"
}

# DECIDES, and does not record. 0 = send it (HELD_BACK_NOTE says how many repeats were
# held since the last delivery; DEDUP_FILE names the record for dedup_commit), 1 = hold.
# The lock (fd 9) is TAKEN here and RELEASED by dedup_done, after the POST: the record is
# written only once the message was delivered, so the read here and the write there must
# be one critical section or eight simultaneous identical alerts all read "never sent"
# and all go out. That was measured in review: 8 of 8 delivered.
HELD_BACK_NOTE=""
DEDUP_FILE=""
DEDUP_LOCKED=0
dedup_check() { # $1 message
  HELD_BACK_NOTE=""; DEDUP_FILE=""; DEDUP_LOCKED=0
  [ "$DEDUP" = 1 ] || return 0
  [ "$COOLDOWN" -gt 0 ] || return 0
  local key f now last count
  key="$(dedup_key "$1")"; [ -n "$key" ] || return 0
  if ! dedup_dir_ok; then
    log "dedup OFF: $STATE_DIR is not a directory this script owns (no .faucet-alerts marker and not empty, or not writable); repeats of this alert will all be sent"
    return 0
  fi
  f="$STATE_DIR/$key"
  # ONE LOCK PER CAUSE, not one for the directory. The lock is held across the POST, so a
  # shared lock made every distinct cause queue behind every other's send: eight causes at
  # curl's 10-second ceiling blew the 30-second wait, and past the wait the decision fails
  # fully open, which is the original flood back under exactly the load this exists for.
  # Per cause, the queue is only ever the identical alerts, which is the one set that
  # should wait. The file is named after the key and dot-prefixed, so the weekly sweep and
  # the ownership check both know it as ours.
  # A GROUP redirect, so the open is one attempt whose error is silenced: a failed
  # redirection on a bare `exec` prints before a 2>/dev/null on the same line applies, and
  # a probe-then-exec left a window in which both raw errors still appeared.
  if ! { exec 9>>"$STATE_DIR/.lock.$key"; } 2>/dev/null; then
    log "dedup OFF: cannot open the cooldown lock in $STATE_DIR; repeats of this alert will all be sent"
    return 0
  fi
  DEDUP_LOCKED=1
  # The wait outlives curl's --max-time (10 s) with room, because the holder keeps the lock
  # across its POST: a waiter that gives up early sends unserialised, and review measured
  # that as the second duplicate source once the first was closed.
  if command -v flock >/dev/null 2>&1; then
    flock -w 30 9 || log "WARNING: could not take the cooldown lock in 30s; deciding unserialised"
  fi
  # `now` is read AFTER the lock, not before. Read before it, every waiter queued behind a
  # slow POST held a timestamp older than the record the winner then wrote, the
  # clock-stepped-back guard below zeroed that record, and all of them sent: 8 of 8 at a
  # 2-second POST, measured in review. The lock was correct; the value judged under it
  # was stale.
  now="$(date -u +%s)"
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
    dedup_done
    log "HELD BACK (same alert within ${COOLDOWN}s, $((count + 1)) so far): $1"
    return 1
  fi
  DEDUP_FILE="$f"
  if [ "$count" -gt 0 ]; then
    if [ "$COOLDOWN" -ge 60 ]; then
      HELD_BACK_NOTE=" (+$count identical held back in the last $((COOLDOWN / 60)) min)"
    else
      HELD_BACK_NOTE=" (+$count identical held back in the last ${COOLDOWN}s)"
    fi
  fi
  return 0
}

# Releases the lock. Called after the POST, whatever it did.
dedup_done() {
  [ "$DEDUP_LOCKED" = 1 ] || return 0
  exec 9>&-
  DEDUP_LOCKED=0
}

# Called ONLY after the POST succeeded: that is when the window starts. Records for
# causes that stopped firing are never read again; a week is long past any window. The
# sweep matches EXACTLY the key shape, forty hex characters and nothing else: the first
# version's `[0-9a-f]*` also matched access.log, backup.tar.gz and faucet.db in a directory
# somebody later shared with us. The marker check is defence in depth behind
# dedup_dir_ok, which is what refuses a directory that is not ours before this ever runs.
dedup_commit() {
  [ -n "$DEDUP_FILE" ] || return 0
  printf '%s 0\n' "$(date -u +%s)" > "$DEDUP_FILE" 2>/dev/null || true
  if [ -e "$STATE_DIR/.faucet-alerts" ]; then
    find "$STATE_DIR" -maxdepth 1 -type f -regextype posix-extended -regex '.*/[0-9a-f]{40}' -mtime +7 -delete 2>/dev/null
    # Lock files outlive their records by a month, so a cause that stopped firing does not
    # leave an inode behind for ever; a live cause touches its lock on every decision.
    find "$STATE_DIR" -maxdepth 1 -type f -regextype posix-extended -regex '.*/\.lock\.[0-9a-f]{40}' -mtime +30 -delete 2>/dev/null
  fi
  return 0
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
  # The held-back count goes on the FIRST line, where a phone preview shows it, not after
  # a 15-line journal tail where the unit alerts would have buried it.
  local first rest
  first="${1%%$'\n'*}"; rest="${1#"$first"}"
  escaped="$(json_escape "$PREFIX $first$HELD_BACK_NOTE$rest")" || { dedup_done; return 4; }
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
    dedup_done
    log "sent: $first$HELD_BACK_NOTE"
    return 0
  fi
  dedup_done
  log "POST FAILED to the configured webhook: $1"
  return 1
}

case "${1:-}" in
  --self-test)
    # Exercises the real send path, not a hand-written curl, so it proves the
    # code that will page you actually works.
    # Never interpolate the URL: it is a credential and this line goes to the
    # journal on every setup run.
    log "format=$ALERT_FORMAT url=$([ -n "$ALERT_URL" ] && echo set || echo UNSET) cooldown=${COOLDOWN}s (configured: '$COOLDOWN_RAW')"
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
    # One cause per unit TEMPLATE, whatever the instance id looks like (see DEDUP_SUBJECT).
    DEDUP_SUBJECT="unit $(printf '%s' "$unit" | sed -E 's/@.*\./@./')"
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
