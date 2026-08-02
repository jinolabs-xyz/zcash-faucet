#!/usr/bin/env bash
# REFUSE TO START THE cTAZ NODE IF ITS STATE HAS ALREADY OUTGROWN THE BOX.
#
# THIS IS NOT A QUOTA and must not be read as one. systemd has no size limit for
# StateDirectory, so nothing here stops a running node from filling the disk; a real
# ceiling needs a filesystem quota or a dedicated volume, which is an open item on #327.
# What this does is refuse to START a node whose state is already past what we can spare,
# which turns "the disk filled up and the faucet died" into "the feature-net node did not
# come back after a restart, and said why".
#
# WHY THE NUMBER IS UNCERTAIN, and why the guard exists anyway. Measured growth on that
# chain: 20.8 KB/block at height 428, 29.8 at 1,648, 66.1 at 22,193. Per-block cost RISES
# with height, so every extrapolation from an early prefix understates -- mine went 7.4 GB,
# then 10.6, then 23.5, against 28 GB free on the box. Until a node reaches the tip the
# honest state of that number is UNKNOWN, and a guard sized on a guess with margin is
# better than no guard while the number is unknown.
#
# EXIT CODES, matching the rest of the ops scripts:
#   0  under the ceiling, or nothing on disk yet
#   1  KNOWN-BAD, over the ceiling, refuse to start
#   2  CANNOT-VERIFY, the size could not be measured
set -uo pipefail

DIR="${1:-}"
MAX_GB="${2:-}"

log() { echo "$(date -u +%FT%TZ) ctaz-datadir-guard: $*"; }

[ -n "$DIR" ] && [ -n "$MAX_GB" ] || {
  echo "usage: ctaz-datadir-guard.sh <datadir> <max-gb>" >&2
  exit 2
}
case "$MAX_GB" in
  ''|*[!0-9]*) log "CANNOT VERIFY: max-gb must be a whole number of GB, got '$MAX_GB'"; exit 2 ;;
esac
[ "$MAX_GB" -gt 0 ] || { log "CANNOT VERIFY: max-gb must be above zero"; exit 2; }

# A datadir that does not exist yet is the normal first-boot case, not a fault.
if [ ! -d "$DIR" ]; then
  log "no datadir at $DIR yet, nothing to check"
  exit 0
fi

# du -sk rather than -sh: parsing a human-readable size means parsing G/M/K, and a locale
# that prints a comma turns a check into a coin flip.
used_kb="$(du -sk "$DIR" 2>/dev/null | awk '{print $1}')"
case "${used_kb:-}" in
  ''|*[!0-9]*)
    log "CANNOT VERIFY: could not measure $DIR."
    log "  Not starting on the assumption it is small: that assumption is exactly what"
    log "  this guard exists to remove."
    exit 2 ;;
esac

max_kb=$((MAX_GB * 1024 * 1024))
used_gb_x10=$(( used_kb * 10 / 1024 / 1024 ))

if [ "$used_kb" -gt "$max_kb" ]; then
  log "REFUSING TO START: $DIR holds $((used_gb_x10 / 10)).$((used_gb_x10 % 10)) GB, ceiling is ${MAX_GB} GB."
  log "  The cTAZ node is best-effort and the TAZ faucet is not. Freeing this is a"
  log "  decision for a human: re-sync from a snapshot, raise CTAZ_MAX_STATE_GB in"
  log "  /etc/faucet/ctaz.env if the box genuinely has the room, or leave it stopped."
  exit 1
fi

log "ok: $DIR holds $((used_gb_x10 / 10)).$((used_gb_x10 % 10)) GB of a ${MAX_GB} GB ceiling"
exit 0
