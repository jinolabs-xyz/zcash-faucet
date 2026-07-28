#!/usr/bin/env bash
# Runs the audits on a schedule and alerts with the reason named. See the
# Config drift section of OPERATIONS.md.
set -uo pipefail

DRIFT_AUDIT="${DRIFT_AUDIT:-$(dirname "$0")/audit-drift.sh}"
ACCESS_AUDIT="${DRIFT_ACCESS_AUDIT:-$(dirname "$0")/audit-access.sh}"
ALERT_SH="${DRIFT_ALERT_SH:-$(dirname "$0")/alert.sh}"
DRIFT_RUN_ACCESS="${DRIFT_RUN_ACCESS:-1}"

log() { echo "$(date -u +%FT%TZ) drift-report: $*"; }

# Expected outcomes (drift found, audit incomplete) are alerted here with the
# cause named, because "unit failed" does not tell an operator which it was.
# Only an unexpected failure exits nonzero, leaving OnFailure to catch it.

# Set when we knew something and could not deliver it. Audit-blind means we do
# not know. Alert-failed means we DO know and the person who needs to does not,
# which is worse, so it escalates the same way an unrunnable audit does.
undelivered=0

notify() { # $1 = message. Returns alert.sh's own rc so the cause survives.
  local out rc
  if [ ! -x "$ALERT_SH" ]; then
    log "ALERT NOT SENT: no runnable alert script at $ALERT_SH"
    return 1
  fi
  # alert.sh exits 1 POST failed / 3 nothing configured / 4 no encoder, and
  # those want three different fixes. Discarding the rc made them one silence.
  out="$("$ALERT_SH" "$1" 2>&1)"; rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  case "$rc" in
    0) ;;
    3) log "ALERT NOT SENT: no FAUCET_ALERT_URL configured, set one in /etc/faucet/alerts.env" ;;
    4) log "ALERT NOT SENT: no jq and no python3, so the alert body cannot be encoded. Install either one." ;;
    *) log "ALERT NOT SENT: alert.sh exited $rc, so the webhook rejected the POST or curl could not reach it" ;;
  esac
  return "$rc"
}

# Every finding goes through here, so a finding can never be logged without
# something noticing that nobody was told about it.
notify_finding() {
  notify "$1" && return 0
  undelivered=1
  log "a finding was made and could NOT be delivered, so this unit will fail on purpose: systemctl is the only signal left"
  return 1
}

run_audit() { # $1 label, $2 script path
  local label="$1" script="$2" out rc
  if [ ! -x "$script" ]; then
    log "ERROR: $label audit missing or not executable at $script"
    return 3
  fi
  out="$("$script" --verbose 2>&1)"; rc=$?
  printf '%s\n' "$out"
  case "$rc" in
    0) log "$label: clean" ;;
    1) log "$label: DRIFT FOUND"
       notify_finding "$label drift found on $(hostname 2>/dev/null || echo the box). The box and the repo disagree, so a rebuild would not reproduce it. Findings and their fixes: journalctl -u faucet-drift-report -n 200" ;;
    2) log "$label: INCOMPLETE, some checks could not run"
       notify_finding "$label audit INCOMPLETE on $(hostname 2>/dev/null || echo the box). Not a clean result, some checks could not run, so drift may exist unseen: journalctl -u faucet-drift-report -n 200" ;;
    *) log "$label: unexpected exit $rc" ;;
  esac
  return "$rc"
}

worst=0
run_audit "config" "$DRIFT_AUDIT"; drift_rc=$?
[ "$drift_rc" -gt "$worst" ] && worst=$drift_rc

if [ "$DRIFT_RUN_ACCESS" = "1" ]; then
  log ""
  run_audit "access" "$ACCESS_AUDIT"; access_rc=$?
  [ "$access_rc" -gt "$worst" ] && worst=$access_rc
fi

# An undelivered finding is this wrapper's problem too, so it joins the same
# class. It is deliberately noisy when no webhook is configured at all: a box
# with drift and no alerting has systemctl as its last signal, and a green unit
# there would hide the drift the same way discarding the rc did.
[ "$undelivered" = "1" ] && worst=3

# 3 means an audit could not be run, or a finding could not be delivered.
# Either way it is a fact about this wrapper rather than about the box, so let
# systemd see it and page through OnFailure.
[ "$worst" = "3" ] && exit 1
exit 0
