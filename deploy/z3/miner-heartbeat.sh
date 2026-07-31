#!/usr/bin/env bash
# Publish what the miner is ACTUALLY doing, for /api/status to read (#miner-state).
#
# WHY THIS EXISTS. /api/status used to report the miner from FAUCET_MINER_ACTIVE, an
# env flag, so it reported intent rather than behaviour and could never be false while
# the miner was broken. On 2026-07-31 it read "on" for 70 minutes while the miner
# errored every five seconds: zebra had regenerated its RPC cookie on restart and the
# miner still held the old one. The unit was `active` throughout. Only the templates
# had stopped, so TEMPLATE ACTIVITY is what this reports.
#
# It writes into the faucet's existing /app/data volume, so no compose change is
# needed and the faucet reads it as a plain file.
#
# FAILS TO "cannot say", NEVER TO "fine". If journald gives us nothing we write
# readable:false, and the app renders that as unverified rather than as healthy. A
# heartbeat that lies in the reassuring direction would be worse than no heartbeat.
# ENABLEMENT IS NOT AUTOMATIC. install-ops.sh installs units and deliberately does
# not enable them, so after a deploy this timer exists and does not fire, and the app
# correctly reports the miner as "unverified" rather than pretending. audit-drift.sh
# reports a not-enabled unit as drift, so the gap is detected rather than silent. To
# close it:
#
#   systemctl enable --now faucet-miner-heartbeat.timer
set -uo pipefail

UNIT="${MINER_UNIT:-zcash-testnet-miner}"
OUT="${MINER_HEARTBEAT_OUT:-/var/lib/docker/volumes/zcash-faucet_faucet_data/_data/miner-heartbeat.json}"
# How far back to look. Must exceed the app's stale threshold, or a miner that has
# been quiet for a while would drop out of our window and we would report "cannot
# say" for something we can in fact say is stale.
SINCE="${MINER_HEARTBEAT_SINCE:-30 min ago}"

write() { # $1 json body
  tmp="$(mktemp "${OUT}.XXXXXX")" || return 1
  printf '%s\n' "$1" > "$tmp"
  chmod 644 "$tmp"
  # Atomic, so a reader never sees a half-written file.
  mv -f "$tmp" "$OUT"
}

cannot_say() { write '{"readable":false}'; exit 0; }

command -v journalctl >/dev/null 2>&1 || cannot_say
mkdir -p "$(dirname "$OUT")" 2>/dev/null || cannot_say

# The miner logs one of these per fetched template:
#   miner: template: height 4227652 bits 1f158ac4 txs 1
# Take the newest, with its journal timestamp. --output=short-unix gives an epoch
# with fractional seconds, which is a machine format rather than a locale-dependent
# one: a parser keyed on human dates breaks the first time the box changes locale.
line="$(journalctl -u "$UNIT" --since "$SINCE" --output=short-unix --no-pager 2>/dev/null \
        | grep -F 'miner: template: height ' | tail -n1)"

# No matching line is NOT proof of a healthy miner and NOT proof of a dead one from
# this script's point of view: it means nothing in our window, so the app decides.
[ -n "$line" ] || cannot_say

epoch="${line%% *}"
height="$(printf '%s' "$line" | sed -n 's/.*miner: template: height \([0-9]\{1,\}\).*/\1/p')"

case "$epoch" in
  ''|*[!0-9.]*) cannot_say ;;
esac
[ -n "$height" ] || cannot_say

# Milliseconds, because the app compares against Date.now().
ms="$(printf '%s' "$epoch" | awk '{printf "%d", $1 * 1000}')"
write "{\"height\":${height},\"at\":${ms},\"readable\":true}"
