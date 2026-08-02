#!/usr/bin/env bash
# CAN THE CROSSLINK NODE HAVE THIS PORT? Checks all four slots, not the one you picked.
#
# WHY FOUR. A crosslink zebrad derives its whole port family from ONE config value,
# network.listen_addr, at zebrad/src/commands/start.rs:664-682. With P as the P2P port:
#
#     P - 1        zebrad JSON-RPC
#     P            P2P
#     P + 10000    zaino JSON-RPC
#     P + 10001    zaino gRPC, and as shipped this one binds 0.0.0.0, not loopback
#
# So choosing a base port is not choosing a port, it is choosing four, and two of them are
# ten thousand away from the number you typed. That is what makes this worth a script.
#
# THE CONCRETE CASE THIS EXISTS FOR. Their default base is 8233. The obvious worry was
# their RPC at 8232 colliding with ours, and on a testnet box it does NOT: our zebra RPC is
# 18232. The actual collision is zaino's JSON-RPC at 8233+10000 = 18233, which is OUR ZEBRA
# P2P PORT. It arrives from a formula rather than from anything you can read in their
# config, and audit-access.sh would not flag it, because 18233 is on its allowed-public
# list already. Nobody was going to catch that by eye.
#
# EXIT CODES, matching redeploy.sh and bring-to-spec.sh:
#   0  all four slots are free
#   1  KNOWN-BAD, at least one slot collides, and the script says which and with what
#   2  CANNOT-VERIFY, the check could not read what it needed to compare against
set -uo pipefail

REPO_DIR="${CTAZ_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DEPLOY_SH="${CTAZ_DEPLOY_SH:-$REPO_DIR/deploy/deploy.sh}"
ACCESS_SH="${CTAZ_ACCESS_SH:-$REPO_DIR/deploy/z3/audit-access.sh}"
LISTEN_CMD="${CTAZ_LISTEN_CMD:-}"

log() { echo "$(date -u +%FT%TZ) ctaz-port-check: $*"; }
die() { log "ERROR: $*"; exit 1; }

usage() {
  cat <<USAGE
usage: ctaz-port-check.sh <base-p2p-port>
       ctaz-port-check.sh --suggest        propose a base whose four slots are all free

Checks P-1, P, P+10000 and P+10001 against the ports this repo declares and against
whatever is listening right now.
USAGE
}

# ── what the repo says it already uses ───────────────────────────────────────────
# Parsed out of the repo rather than restated here, because a copy would drift and a
# drifted copy is worse than none: it would report "free" for a port we had taken since.
declared_ports() {
  # every port in the loopback-bindings block, both networks, since the block declares both
  sed -n '/^Z3_LOOPBACK_BINDINGS=(/,/^)/p' "$DEPLOY_SH" 2>/dev/null \
    | grep -oE '[0-9]{4,5}' || true
  # and the ports we deliberately expose
  sed -n 's/^ACCESS_PUBLIC_PORTS="\${ACCESS_PUBLIC_PORTS:-\([0-9 ]*\)}".*/\1/p' "$ACCESS_SH" 2>/dev/null \
    | tr ' ' '\n' | grep -oE '[0-9]{2,5}' || true
}

# What is a port used FOR, so the failure names something a human recognises.
describe_declared() {
  case "$1" in
    18232|8232)  echo "our zebra JSON-RPC" ;;
    18233|8233)  echo "our zebra P2P (public by intent)" ;;
    18080|8080)  echo "our zebra health endpoint" ;;
    40232|28232) echo "our Zallet JSON-RPC" ;;
    18137|8137)  echo "our Zaino gRPC" ;;
    18237|8237)  echo "our Zaino JSON-RPC" ;;
    22)          echo "ssh" ;;
    80)          echo "http" ;;
    443)         echo "https" ;;
    *)           echo "declared in this repo" ;;
  esac
}

slot_role() {
  case "$1" in
    rpc)   echo "crosslink zebrad JSON-RPC (P-1)" ;;
    p2p)   echo "crosslink P2P (P)" ;;
    zjson) echo "crosslink zaino JSON-RPC (P+10000)" ;;
    zgrpc) echo "crosslink zaino gRPC (P+10001), binds 0.0.0.0 as shipped" ;;
  esac
}

# ── what is actually listening ───────────────────────────────────────────────────
# Separate from the declaration on purpose. The repo saying a port is free and the box
# having it free are different claims, and only one of them stops a bind from failing.
listening_ports() {
  if [ -n "$LISTEN_CMD" ]; then
    $LISTEN_CMD 2>/dev/null
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}'
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk '{print $4}'
  else
    return 1
  fi
}

[ $# -ge 1 ] || { usage; exit 2; }

# ── read the declarations, and REFUSE an empty read ──────────────────────────────
# An earlier version of this check ran its greps against the wrong working directory,
# matched zero files, and reported every port free. A check that cannot see its subject
# says so; it does not pass.
declared="$(declared_ports | sort -un)"
declared_count="$(printf '%s\n' "$declared" | grep -c '[0-9]' || true)"
if [ "${declared_count:-0}" -lt 4 ]; then
  log "CANNOT VERIFY: read only ${declared_count:-0} declared port(s) from the repo."
  log "  Expected the loopback-bindings block in $DEPLOY_SH and ACCESS_PUBLIC_PORTS in"
  log "  $ACCESS_SH. Reporting ports free on this basis would be a guess wearing a result."
  exit 2
fi

live="$(listening_ports)"
live_rc=$?
live_known=1
if [ "$live_rc" -ne 0 ]; then
  live_known=0
  log "NOTE: no lsof or ss on this host, so nothing could be checked against what is"
  log "  actually listening. The repo-declaration half still runs."
fi

check_base() { # $1 base port -> 0 free, 1 collision; prints findings
  local p="$1" bad=0 slot port role d
  for slot in rpc p2p zjson zgrpc; do
    case "$slot" in
      rpc)   port=$((p - 1)) ;;
      p2p)   port=$p ;;
      zjson) port=$((p + 10000)) ;;
      zgrpc) port=$((p + 10001)) ;;
    esac
    role="$(slot_role "$slot")"
    if printf '%s\n' "$declared" | grep -qx "$port"; then
      d="$(describe_declared "$port")"
      log "  COLLISION  $port  $role"
      log "             already $d"
      bad=1
    elif [ "$live_known" = "1" ] && printf '%s\n' "$live" | grep -qE "[:.]$port\$"; then
      log "  COLLISION  $port  $role"
      log "             something is listening on it right now"
      bad=1
    else
      log "  free       $port  $role"
    fi
  done
  return $bad
}

if [ "$1" = "--suggest" ]; then
  # Walk a sensible range and return the first base whose whole family is clear. Quiet,
  # because the caller wants a number, not a transcript.
  for cand in $(seq 19233 19333); do
    if check_base "$cand" >/dev/null 2>&1; then
      log "suggested base P2P port: $cand"
      log "  -> rpc $((cand-1)), p2p $cand, zaino json $((cand+10000)), zaino grpc $((cand+10001))"
      [ "$live_known" = "1" ] || { log "  (live listeners were NOT checked on this host)"; exit 2; }
      exit 0
    fi
  done
  log "CANNOT SUGGEST: no base in 19233-19333 has all four slots free."
  exit 2
fi

case "$1" in
  ''|*[!0-9]*) usage; exit 2 ;;
esac
BASE="$1"
[ "$BASE" -gt 1024 ] || die "base port must be above 1024, got $BASE"
[ "$BASE" -lt 55535 ] || die "base port must be below 55535 so P+10001 fits, got $BASE"

log "checking base $BASE against $declared_count declared port(s)$([ "$live_known" = 1 ] && echo " and live listeners" || echo "")"
if check_base "$BASE"; then
  if [ "$live_known" = "0" ]; then
    log "all four slots are free of REPO-DECLARED ports, but live listeners were not checked"
    exit 2
  fi
  log "all four slots are free"
  exit 0
fi
log "base $BASE is not usable: at least one derived slot collides."
log "  Remember the collision may be ten thousand ports from the number you chose."
exit 1
