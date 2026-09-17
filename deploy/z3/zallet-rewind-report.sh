#!/usr/bin/env bash
# Count zallet's wallet rewinds and re-scans over a window, read-only.
#
# WHAT A REWIND LOOKS LIKE FROM OUTSIDE, and why nothing we run notices one. On 2026-09-16 at
# 02:29Z zallet rewound 998 blocks and re-scanned for eleven minutes. Zebra was at the tip the
# whole time and the watchdog journal has no stall line, because the watchdog reads ZEBRA.
# Readiness reads `getwalletstatus.wallet_tip.height`, and during a re-scan that number stays
# PINNED at the pre-rewind height while the scan runs beneath it - so the wallet looked frozen,
# readiness compared it against zebra's tip and refused every drip for nine minutes with the
# word "node syncing". The refusal was correct; a drip built against a wallet fifty blocks
# behind is the born-expired family. What was missing is that nothing observes "re-scanning"
# as a STATE: the watchdog reads zebra, readiness reads wallet_tip, and neither has a name for
# the thing in between.
#
# THE ONLY PLACE THE REWIND IS VISIBLE IS THE SCAN LOG, so that is what this reads. Per minute:
# how many blocks were scanned, and the first and last height. A minute whose FIRST height is
# below the previous minute's LAST is a rewind, and the difference is its depth. A minute that
# scans far more blocks than the chain mints (about 5-7 at today's rate) is the re-scan running.
#
# This existed as an awk one-liner in one engineer's notes after the incident. A detector that
# lives in one seat's memory is not a detector, which is why it is a file with tests (#602).
#
# READ-ONLY, AND THAT IS THE WHOLE POINT. It runs `docker logs` and nothing else: no wallet is
# stopped, no database is opened, no container is restarted. It is safe on a live faucet and it
# is meant to be handed to the owner as-is.
#
# Usage:
#     bash deploy/z3/zallet-rewind-report.sh                       # the last 24 hours
#     bash deploy/z3/zallet-rewind-report.sh --since 2026-09-16T02:15:00Z --until 2026-09-16T02:45:00Z
#     bash deploy/z3/zallet-rewind-report.sh --all-minutes         # every minute, not just the rewinds
#
# Exit 0 whether or not rewinds were found: "none in this window" is an answer, and a non-zero
# exit would make a clean window look like a broken command in a cron or a paste.
set -euo pipefail

SINCE="24h"
UNTIL=""
ALL_MINUTES=0
ZALLET_CONTAINER="${ZALLET_CONTAINER:-z3-testnet-zallet-1}"

while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:?--since needs a value}"; shift 2 ;;
    --until) UNTIL="${2:?--until needs a value}"; shift 2 ;;
    --all-minutes) ALL_MINUTES=1; shift ;;
    --container) ZALLET_CONTAINER="${2:?--container needs a value}"; shift 2 ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "usage: $(basename "$0") [--since X] [--until Y] [--container NAME] [--all-minutes]" >&2; exit 64 ;;
  esac
done

# One description of the window, built once: the nested quoting needed to inline it twice reads
# as an unexpanded variable to shellcheck and to the next person.
WINDOW="--since $SINCE"
[ -n "$UNTIL" ] && WINDOW="$WINDOW --until $UNTIL"

# THE ANSI STRIP IS NOT COSMETIC. zallet colours its timestamps, so the raw first field is not a
# time and every field offset after it is wrong. A grep that "found nothing" against a coloured
# log is the failure this line prevents, and it reports as a quiet clean window.
LOG="$(docker logs --since "$SINCE" ${UNTIL:+--until "$UNTIL"} "$ZALLET_CONTAINER" 2>&1 \
       | sed 's/\x1b\[[0-9;]*m//g' || true)"

SCANS="$(printf '%s\n' "$LOG" | grep -c 'Scanning block' || true)"
if [ "${SCANS:-0}" = "0" ]; then
  # AN EMPTY RESULT IS AMBIGUOUS AND MUST SAY SO. No scan lines means either a quiet wallet or a
  # window with no log at all, and those are opposite facts. Reporting "0 rewinds" for both is
  # how a broken window reads as a healthy one.
  LINES="$(printf '%s\n' "$LOG" | grep -c . || true)"
  if [ "${LINES:-0}" = "0" ]; then
    echo "NO LOG in this window for $ZALLET_CONTAINER ($WINDOW). This is not 'no rewinds': nothing was read." >&2
    exit 1
  fi
  echo "no 'Scanning block' lines in this window, though the container logged ${LINES} other lines: the wallet scanned nothing here"
  exit 0
fi

# Per minute: count, first height, last height. The height is the last field of the scan line
# and the minute is the HH:MM of the leading RFC3339 timestamp; both are read by position rather
# than by regex over the whole line, because the message text has changed between zallet builds
# and the timestamp has not.
PERMIN="$(printf '%s\n' "$LOG" | grep 'Scanning block' | awk '
  {
    ts = $1
    # 2026-09-16T02:29:01.123456Z -> 02:29
    minute = substr(ts, 12, 5)
    # THE MINUTE HAS TO LOOK LIKE A MINUTE, not merely be five characters at offset 12. A scan
    # line with no leading timestamp yields "" here while its height still parses, so without this
    # the line is COUNTED - reconciliation sees nothing missing and a bogus empty minute joins the
    # table. Checking only the half that happens to parse is how a partial read passes for whole.
    if (minute !~ /^[0-9][0-9]:[0-9][0-9]$/) next
    h = $NF
    gsub(/[^0-9]/, "", h)
    if (h == "") next
    consumed++
    if (!(minute in n)) { lo[minute] = h; order[++k] = minute }
    hi[minute] = h
    n[minute]++
  }
  END {
    # The parser reports how much it CONSUMED, so the caller can reconcile it against how many
    # scan lines there were. Without that, a format change that breaks some lines and not others
    # is a smaller sample reported as a complete answer (SDE-UI, review of #639).
    print "CONSUMED", consumed
    for (i = 1; i <= k; i++) { m = order[i]; print m, n[m], lo[m], hi[m] }
  }
')"
CONSUMED="$(printf '%s\n' "$PERMIN" | awk '$1 == "CONSUMED" { print $2 }')"
# `|| true`: when NOTHING parsed the only line is the CONSUMED marker, so this grep matches
# nothing and exits 1 - and under `set -e` that killed the script before it could say why, which
# is the silent death this file exists to avoid.
PERMIN="$(printf '%s\n' "$PERMIN" | grep -v '^CONSUMED ' || true)"

if [ -z "$PERMIN" ]; then
  echo "found $SCANS 'Scanning block' lines but could not read a height or a timestamp from any of them." >&2
  echo "The log format has moved; this script reads the height as the last field and the minute from an RFC3339 first field." >&2
  exit 1
fi

# ALL-OR-NOTHING IS NOT ENOUGH, and the gap is the interesting one (SDE-UI, review of #639). The
# refusal above only fires when NOT ONE line parses. A format change that breaks SOME of them
# leaves a smaller sample reported as a complete answer, and a smaller sample of a rewind count is
# indistinguishable from fewer rewinds.
if [ "${CONSUMED:-0}" != "$SCANS" ]; then
  echo "read $SCANS 'Scanning block' lines but could only parse ${CONSUMED:-0} of them." >&2
  echo "A partial read is not a smaller answer, it is a different question. The log format has moved." >&2
  exit 1
fi

# AND A NUMBER IN THE RIGHT PLACE IS NOT A HEIGHT. The reader is positional - the height is the
# last field - so any format change that leaves something numeric at the end REDEFINES it: append a
# duration to each line and the report becomes "first 250, last 310" on a chain at 4.35 million,
# which is a confident answer about nothing and would send an incident reader somewhere wrong. This
# fails on the VALUE rather than on a count, because a count is something a future format could
# satisfy just as easily.
MIN_PLAUSIBLE_HEIGHT=100000
IMPLAUSIBLE="$(printf '%s\n' "$PERMIN" | awk -v min="$MIN_PLAUSIBLE_HEIGHT" '$3 + 0 < min || $4 + 0 < min { print $1 ": " $3 "-" $4 }' | head -n3)"
if [ -n "$IMPLAUSIBLE" ]; then
  echo "the heights this read do not look like chain heights (below $MIN_PLAUSIBLE_HEIGHT):" >&2
  printf '  %s\n' "$IMPLAUSIBLE" >&2
  echo "The height is read as the last field of the scan line. If the format now ends in something else - a duration, a count, an elapsed time - that is what these are." >&2
  exit 1
fi

echo "$ZALLET_CONTAINER, $WINDOW: $SCANS scan lines over $(printf '%s\n' "$PERMIN" | wc -l | tr -d ' ') minute(s)"
echo

printf '%s\n' "$PERMIN" | awk -v all="$ALL_MINUTES" '
  BEGIN { prev_hi = ""; printf "%-7s %7s %11s %11s  %s\n", "minute", "scanned", "first", "last", "note" }
  {
    m = $1; c = $2; lo = $3; hi = $4
    note = ""
    if (prev_hi != "" && lo + 0 < prev_hi + 0) {
      note = "REWIND of " (prev_hi - lo) " blocks"
      rew++
    }
    if (all == 1 || note != "") printf "%-7s %7d %11d %11d  %s\n", m, c, lo, hi, note
    prev_hi = hi
  }
  END {
    printf "\n%d rewind(s) in this window.\n", rew
    if (rew == 0) print "A window with no rewind is not proof the trigger is gone: widen it with --since before concluding that."
  }
'

echo
echo "Every line above is a read of 'docker logs'. Nothing was stopped, opened or written."
echo "To see every minute rather than only the rewinds, add --all-minutes."
