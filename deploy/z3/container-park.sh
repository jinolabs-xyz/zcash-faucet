#!/usr/bin/env bash
# Park (or release) ONE container so the watchdog stops restarting it, without stopping
# the watchdog itself.
#
# WHY THIS EXISTS. Step 2 of the watchdog restarts any stopped container, so an intentional
# pause used to need `systemctl stop faucet-watchdog` first. That trades one paused service
# for no supervision of ANY of them: on 2026-10-08 zallet and the watchdog stopped in the
# same second for the NU7 pause, and for the 45 hours after it nothing watched caddy,
# faucet-web or zebra, and nothing would have paged if one had died. The pause was right.
# Losing the watchdog with it was not.
#
# A marker says "a human stopped this on purpose" in a way a running supervisor can read,
# so the watchdog keeps sweeping and paging and declines to start only this one container.
# Persistent on purpose (same reason as the fork park marker): a reboot does not resolve
# the thing you paused for.
#
# Usage, on the box:
#   bash deploy/z3/container-park.sh park   z3-testnet-zallet-1 "NU7: no zallet release yet"
#   bash deploy/z3/container-park.sh status
#   bash deploy/z3/container-park.sh release z3-testnet-zallet-1
set -euo pipefail

DIR="${WATCHDOG_CONTAINER_PARK_DIR:-/var/lib/faucet-watchdog}"
marker() { printf '%s/container-parked-%s' "$DIR" "$1"; }

case "${1:-}" in
  park)
    name="${2:?usage: park <container> [reason]}"; reason="${3:-no reason given}"
    docker inspect "$name" >/dev/null 2>&1 || { echo "no such container: $name" >&2; exit 1; }
    mkdir -p "$DIR"
    # Marker BEFORE the stop. The other order leaves a window in which the container is
    # down and unmarked, which is exactly when a watchdog sweep would start it again.
    printf '%s parked: %s\n' "$(date -u +%FT%TZ)" "$reason" >> "$(marker "$name")"
    docker stop -t 30 "$name" >/dev/null 2>&1 || true
    echo "parked $name"
    echo "  marker: $(marker "$name")"
    echo "  the watchdog keeps running and keeps paging; it will not start this container."
    echo "  release with: bash deploy/z3/container-park.sh release $name"
    ;;
  release)
    name="${2:?usage: release <container>}"
    rm -f "$(marker "$name")"
    docker start "$name" >/dev/null 2>&1 || true
    echo "released $name; the watchdog will supervise it again"
    ;;
  status)
    shopt -s nullglob
    found=0
    for f in "$DIR"/container-parked-*; do
      found=1; n="${f##*/container-parked-}"
      printf 'parked: %-28s state=%s\n' "$n" "$(docker inspect -f '{{.State.Status}}' "$n" 2>/dev/null || echo unknown)"
      sed 's/^/    /' "$f"
    done
    [ "$found" = 1 ] || echo "nothing parked"
    ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
