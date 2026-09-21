#!/usr/bin/env bash
# Runs the audits on a schedule and alerts with the reason named. See the
# Config drift section of OPERATIONS.md.
set -uo pipefail

DRIFT_AUDIT="${DRIFT_AUDIT:-$(dirname "$0")/audit-drift.sh}"
ACCESS_AUDIT="${DRIFT_ACCESS_AUDIT:-$(dirname "$0")/audit-access.sh}"
ALERT_SH="${DRIFT_ALERT_SH:-$(dirname "$0")/alert.sh}"
DRIFT_RUN_ACCESS="${DRIFT_RUN_ACCESS:-1}"
# Where this run's counts and the previous run's finding set live. box-report.sh reads
# summary.json from here every five minutes and carries it to /api/status, which is how a
# drift verdict reaches a GitHub run (live-smoke) instead of only this unit's journal.
STATE_DIR="${DRIFT_STATE_DIR:-/var/lib/faucet-drift}"
SUMMARY="$STATE_DIR/summary.json"
# The checkout the audit compares against. Published beside the counts so a reader can
# tell "clean against main" from "clean against a checkout that stopped moving" - the
# audit itself cannot; live-smoke compares the box's commit to main for that.
REPO_DIR="${AUDIT_REPO_DIR:-/opt/zcash-faucet}"

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

# Each audit says what its own finding MEANS. The two are not the same problem:
# config drift is the box and the repo disagreeing, access is something being
# reachable that should not be. One shared sentence would misdescribe whichever
# audit did not write it, and a wrong explanation at 3am costs more than none.
# THE PAGE GOES OUT WHEN THE FINDING SET CHANGES, NOT ON EVERY RUN. For fourteen nights this
# sent the same sentence about the same 427 lines, and the one new line (the feedback drain's
# timer, never enabled) changed nothing anyone could see (#721). At a 30-minute cadence that
# would be the same page 48 times a day, which is a page nobody reads - so a run pages only
# when what the audit found differs from what it found last time: a new finding, a fixed one,
# or a check that stopped running. The set is hashed from the DRIFT and NOT VERIFIED lines
# (the finding text, not the counts, so one finding replacing another is a change), and the
# hash is stored only after the page was DELIVERED, so an undeliverable change is tried again
# next run rather than forgotten. GitHub (live-smoke reading the summary) is the channel the
# owner watches; this page is for waking someone, and a change is the only thing worth that.
findings_count=0; unverified_count=0
count_findings() { # $1 audit output -> sets findings_count and unverified_count
  findings_count="$(printf '%s\n' "$1" | grep -c '^  DRIFT ')"
  # note_unverified items are the "  - " lines after the NOT VERIFIED heading.
  unverified_count="$(printf '%s\n' "$1" | awk '/^NOT VERIFIED$/{f=1; next} f && /^  - /{n++} END{print n+0}')"
}
finding_set_hash() { # $1 audit output -> a hash of the sorted finding lines
  { printf '%s\n' "$1" | grep -E '^  DRIFT '; printf '%s\n' "$1" | awk '/^NOT VERIFIED$/{f=1; next} f && /^  - /'; } \
    | sort | sha256sum 2>/dev/null | cut -d' ' -f1
}
changed_since_last() { # $1 label, $2 hash -> 0 if the set differs from the stored one
  [ "$(cat "$STATE_DIR/$1.findings.sha" 2>/dev/null)" != "$2" ]
}
remember() { # $1 label, $2 hash; only after delivery
  mkdir -p "$STATE_DIR" 2>/dev/null && printf '%s\n' "$2" > "$STATE_DIR/$1.findings.sha"
}

run_audit() { # $1 label, $2 script path, $3 what a finding means
  local label="$1" script="$2" meaning="$3" out rc host hash prev_n
  if [ ! -x "$script" ]; then
    log "ERROR: $label audit missing or not executable at $script"
    return 3
  fi
  host="$(hostname 2>/dev/null || echo the box)"
  out="$("$script" --verbose 2>&1)"; rc=$?
  printf '%s\n' "$out"
  count_findings "$out"
  hash="$(finding_set_hash "$out")"
  prev_n="$(cat "$STATE_DIR/$label.findings.n" 2>/dev/null || echo "")"
  case "$rc" in
    0) log "$label: clean"
       # Clean after findings is a change worth saying once: the fix landed.
       if changed_since_last "$label" "$hash" && [ -n "$prev_n" ] && [ "$prev_n" != "0" ]; then
         notify "$label drift CLEARED on $host: 0 findings, was $prev_n." && remember "$label" "$hash"
       else
         remember "$label" "$hash"
       fi ;;
    1) log "$label: FINDINGS ($findings_count)"
       if changed_since_last "$label" "$hash"; then
         notify_finding "$label findings CHANGED on $host: $findings_count now${prev_n:+, was $prev_n}. $meaning Findings and their fixes: journalctl -u faucet-drift-report -n 200" \
           && remember "$label" "$hash"
       else
         log "$label: the same $findings_count finding(s) as last run, not paging again; the verdict is on /api/status and in GitHub"
       fi ;;
    2) log "$label: INCOMPLETE, some checks could not run ($unverified_count unverified, $findings_count findings)"
       if changed_since_last "$label" "$hash"; then
         notify_finding "$label audit INCOMPLETE on $host: $unverified_count check(s) could not run, $findings_count finding(s). Not a clean result, so a problem may exist unseen: journalctl -u faucet-drift-report -n 200" \
           && remember "$label" "$hash"
       else
         log "$label: the same incomplete result as last run, not paging again"
       fi ;;
    *) log "$label: unexpected exit $rc" ;;
  esac
  mkdir -p "$STATE_DIR" 2>/dev/null && printf '%s\n' "$findings_count" > "$STATE_DIR/$label.findings.n"
  return "$rc"
}

# THE SUMMARY THE BOX PUBLISHES. Counts only, never a finding's text: /api/status is public
# and box-report's rule applies (a file name missing from a production box is
# reconnaissance). One fixed shape, written by printf and matched by box-report with the
# same shape, so anything that is not exactly this is dropped rather than embedded.
write_summary() { # $1 config rc, $2 config findings, $3 config unverified, $4 access rc, $5 access findings, $6 access unverified
  local sha tmp
  sha="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null | grep -oE '^[0-9a-f]{40}$' || true)"
  mkdir -p "$STATE_DIR" 2>/dev/null || { log "WARNING: cannot create $STATE_DIR, so no summary is published and /api/status will read the drift verdict as unknown"; return 1; }
  tmp="$(mktemp "$SUMMARY.XXXXXX" 2>/dev/null)" || { log "WARNING: cannot write in $STATE_DIR, so no summary is published"; return 1; }
  printf '{"at":%s,"repoSha":"%s","config":{"rc":%s,"findings":%s,"unverified":%s},"access":{"rc":%s,"findings":%s,"unverified":%s}}\n' \
    "$(( $(date +%s) * 1000 ))" "$sha" "$1" "$2" "$3" "$4" "$5" "$6" > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$SUMMARY" \
    || { rm -f "$tmp"; log "WARNING: summary write failed"; return 1; }
  log "summary written to $SUMMARY (config rc=$1 findings=$2 unverified=$3; access rc=$4 findings=$5 unverified=$6; repo ${sha:-unknown})"
}

worst=0
run_audit "config" "$DRIFT_AUDIT" \
  "The box and the repo disagree, so a rebuild would not reproduce this box."
drift_rc=$?
drift_findings="$findings_count"; drift_unverified="$unverified_count"
[ "$drift_rc" -gt "$worst" ] && worst=$drift_rc

# An access audit that is switched off is reported as such (rc 0, nothing counted) rather
# than as a clean run it never made; the summary carries rc, and 0 with the switch off is
# the one case where 0 does not mean "asked". Said here so nobody reads it as a pass.
access_rc=0; access_findings=0; access_unverified=0
if [ "$DRIFT_RUN_ACCESS" = "1" ]; then
  log ""
  run_audit "access" "$ACCESS_AUDIT" \
    "Something is reachable that should not be, or sshd is not throttling the way we set it. Docker publishes ports through its own iptables chain, so check the BINDING and not just ufw."
  access_rc=$?
  access_findings="$findings_count"; access_unverified="$unverified_count"
  [ "$access_rc" -gt "$worst" ] && worst=$access_rc
fi

write_summary "$drift_rc" "$drift_findings" "$drift_unverified" "$access_rc" "$access_findings" "$access_unverified"

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
