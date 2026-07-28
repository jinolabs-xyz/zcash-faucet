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
notify() { [ -x "$ALERT_SH" ] && "$ALERT_SH" "$1" >/dev/null 2>&1; }

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
       notify "$label drift found on $(hostname 2>/dev/null || echo the box). The box and the repo disagree, so a rebuild would not reproduce it. Findings and their fixes: journalctl -u faucet-drift-report -n 200" ;;
    2) log "$label: INCOMPLETE, some checks could not run"
       notify "$label audit INCOMPLETE on $(hostname 2>/dev/null || echo the box). Not a clean result, some checks could not run, so drift may exist unseen: journalctl -u faucet-drift-report -n 200" ;;
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

# 3 means an audit could not be run at all, which is this wrapper's problem
# rather than a finding, so let systemd see it and page through OnFailure.
[ "$worst" = "3" ] && exit 1
exit 0
