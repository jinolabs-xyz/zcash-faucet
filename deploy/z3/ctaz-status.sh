#!/usr/bin/env bash
# Write the Crosslink node's state where the faucet container can read it (#322).
#
# WHY A FILE AND NOT AN RPC CALL. The faucet container cannot reach the node's RPC by any
# route. Measured by the CTO from inside zcash-faucet-faucet-1: 127.0.0.1:19232 is the
# container's own loopback and fails, 172.17.0.1:19232 times out because the node binds
# loopback only, and host.docker.internal is not defined in this compose setup. The same
# call from the host works. So readCtazRecency() calling fetch directly can only ever
# return cannot-verify in production, whatever the toggle says.
#
# The rejected alternative was binding the node RPC to the bridge address. It is cheaper
# and it is worse: it turns a loopback-only surface into one reachable from every container
# on the box, on a node that will hold faucet funds, and it needs firewall care forever to
# stay off the public interface. A permanent widening of attack surface to save a config
# file.
#
# THIS IS ALREADY THE HOUSE PATTERN. box-integrity.json arrives the same way, and
# status/route.ts says out loud that it is a few hundred bytes from a bind mount and does
# not belong in the Promise.all with the network calls. No new listener, no new exposure,
# and it degrades correctly: a stale file reads as unknown rather than as ready, which is
# what the five-state gate already expects.
#
# ABSENT FIELDS ARE null, NEVER ZERO. A percent we could not read must not render as 0%,
# which would say "barely started" about a node that is at tip. Same rule as the box
# report's watchdog counter.
set -uo pipefail

RPC="${CTAZ_RPC_URL:-http://127.0.0.1:19232/}"
OUT="${CTAZ_STATUS_OUT:-/var/lib/docker/volumes/zcash-faucet_faucet_data/_data/ctaz-status.json}"
CURL="${CTAZ_CURL:-curl}"
TIMEOUT="${CTAZ_TIMEOUT:-5}"

log() { echo "$(date -u +%FT%TZ) ctaz-status: $*"; }

rpc() { # $1 method -> raw JSON on stdout, non-zero when the call did not happen
  "$CURL" -fsS --max-time "$TIMEOUT" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[]}" "$RPC" 2>/dev/null
}

# Written atomically. A reader that catches a half-written file would see truncated JSON,
# and boxIntegrityFile's parse-failure path treats that as unreadable, so the panel would
# flap to unknown every time this ran. mv within the same filesystem is atomic.
write() {
  local body="$1" tmp
  mkdir -p "$(dirname "$OUT")" 2>/dev/null || { log "cannot create $(dirname "$OUT")"; exit 1; }
  tmp="$(mktemp "$(dirname "$OUT")/.ctaz-status.XXXXXX")" || exit 1
  printf '%s\n' "$body" > "$tmp" && mv -f "$tmp" "$OUT" || { rm -f "$tmp"; exit 1; }
}

# `at` is always written, even when nothing else could be read, because the READER needs to
# distinguish "this file is old" from "this file says it could not tell". Those are
# different failures: a stale file means this script stopped running, an unreadable-node
# file means the script ran and the node did not answer.
now_ms=$(( $(date +%s) * 1000 ))

if ! info="$(rpc getinfo)"; then
  log "node did not answer getinfo, writing an explicit cannot-read rather than nothing"
  write "{\"readable\":false,\"at\":${now_ms},\"recency\":null,\"blocks\":null,\"syncPercent\":null}"
  exit 0
fi

# jq is not on the box's dependency list, so this stays in grep/sed like the rest of these
# scripts. Numbers only, and a field that does not match yields empty, which becomes null.
num() { printf '%s' "$1" | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*-?[0-9]+" | head -1 | grep -oE '\-?[0-9]+$'; }

blocks="$(num "$info" blocks)"
headers="$(num "$info" headers)"
# estimatedheight is what zebra reports while it is still catching up. Preferred over
# headers when present, because it is the node's own estimate of the network tip.
est="$(num "$info" estimatedheight)"
tip="${est:-$headers}"

# THE PERCENT IS DERIVED HERE AND IT IS ALLOWED TO BE null. Integer arithmetic with one
# decimal place, because bc is not guaranteed either. A tip we do not know means no
# percent: reporting 100% because the denominator was missing is the failure this whole
# file is written to avoid.
pct=null
if [ -n "$blocks" ] && [ -n "$tip" ] && [ "$tip" -gt 0 ] 2>/dev/null; then
  # Cap at 100. blocks can exceed a stale estimatedheight, and 103% is a number nobody
  # can read as anything but a bug.
  p=$(( blocks * 1000 / tip ))
  [ "$p" -gt 1000 ] && p=1000
  pct="$(( p / 10 )).$(( p % 10 ))"
fi

# The finality view, which is what the readiness gate actually classifies on. Its absence
# is not fatal to this file: sync progress is still worth showing on a node whose TFL is
# off, and the gate has its own not-activated state for that.
recency="null"
if r="$(rpc get_tfl_recency_status)"; then
  # Passed through as the raw result object so the app's own readingFor() classifies it,
  # rather than this script deciding a verdict the app already knows how to reach. Two
  # copies of that rule would drift, and the shell copy would be the untested one.
  inner="$(printf '%s' "$r" | sed -n 's/.*"result"[[:space:]]*:[[:space:]]*\({.*}\).*/\1/p')"
  [ -n "$inner" ] && recency="$inner"
fi

write "{\"readable\":true,\"at\":${now_ms},\"blocks\":${blocks:-null},\"tip\":${tip:-null},\"syncPercent\":${pct},\"recency\":${recency}}"
log "wrote $OUT: blocks=${blocks:-unknown} tip=${tip:-unknown} sync=${pct}%"
