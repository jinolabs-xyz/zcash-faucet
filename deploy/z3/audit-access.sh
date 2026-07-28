#!/usr/bin/env bash
# Reports what this box exposes and how sshd is throttling. Read-only, applies
# nothing: the box has one door and a lockout is a dead box. See OPERATIONS.md.
set -uo pipefail

# Public by intent: ssh, http, https. Everything else must be loopback or
# docker-internal, particularly the node and wallet RPC.
ACCESS_PUBLIC_PORTS="${ACCESS_PUBLIC_PORTS:-22 80 443}"
ACCESS_SSHD_CONFIG="${ACCESS_SSHD_CONFIG:-/etc/ssh/sshd_config}"
ACCESS_SS="${ACCESS_SS:-ss}"
ACCESS_UFW="${ACCESS_UFW:-ufw}"
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

findings=0
unverified=""
say()   { echo "$*"; }
ok()    { [ "$VERBOSE" = "1" ] && echo "  ok       $*"; return 0; }
found() { findings=$((findings + 1)); echo "  FINDING  $1"; [ -n "${2:-}" ] && echo "           fix: $2"; return 0; }
skip()  { unverified="${unverified}${unverified:+
}  - $1"; }

is_public_port() { case " $ACCESS_PUBLIC_PORTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

say "access audit for $(hostname 2>/dev/null || echo this box)"
say ""

say "listening sockets reachable from off-box"
if command -v "$ACCESS_SS" >/dev/null 2>&1; then
  # Wildcard binds (0.0.0.0 or ::) are reachable unless the firewall says no.
  while read -r addr port; do
    [ -n "${port:-}" ] || continue
    case "$addr" in
      127.0.0.1|::1|localhost) continue ;;
    esac
    if is_public_port "$port"; then
      ok "port $port on $addr is public by intent"
    else
      found "port $port is bound on $addr, which is off-box reachable and not in the intended set ($ACCESS_PUBLIC_PORTS)" \
            "bind it to 127.0.0.1, or block it: ufw deny $port/tcp"
    fi
  done < <("$ACCESS_SS" -Hltn 2>/dev/null \
             | awk '{print $4}' \
             | sed -E 's/^\[?([0-9a-fA-F:.*]+)\]?:([0-9]+)$/\1 \2/' \
             | sort -u)
else
  skip "listening sockets: no $ACCESS_SS on this host"
fi
say ""

say "firewall"
if command -v "$ACCESS_UFW" >/dev/null 2>&1; then
  ufw_out="$("$ACCESS_UFW" status 2>/dev/null)"
  if printf '%s' "$ufw_out" | grep -qi 'Status: active'; then
    ok "ufw is active"
    # `limit` is rate-limited SSH: 6 connections per 30s per source, which
    # drops parallel ops connections and looks exactly like a kex reset.
    if printf '%s' "$ufw_out" | grep -qiE '^(22|OpenSSH|ssh).*LIMIT'; then
      found "ufw is rate-limiting SSH (LIMIT), which drops bursts of parallel connections and surfaces as kex_exchange_identification resets" \
            "ufw allow OpenSSH   # replaces the LIMIT rule with a plain allow"
    fi
    for p in $ACCESS_PUBLIC_PORTS; do
      printf '%s' "$ufw_out" | grep -qE "(^|[^0-9])$p(/tcp)?[[:space:]]" \
        || found "port $p is intended to be public but has no ufw rule" "ufw allow $p/tcp"
    done
  else
    found "ufw is installed but NOT active, so nothing is filtered" \
          "ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable   # keep a session open while doing this"
  fi
else
  skip "firewall: no $ACCESS_UFW on this host"
fi
say ""

# The connection resets that have cost every ops loop retries tonight. sshd
# drops unauthenticated connections early once MaxStartups is reached, and the
# client reports it as kex_exchange_identification.
say "sshd connection throttling"
if [ -r "$ACCESS_SSHD_CONFIG" ]; then
  startups="$(grep -iE '^[[:space:]]*MaxStartups' "$ACCESS_SSHD_CONFIG" | tail -1 | awk '{print $2}')"
  sessions="$(grep -iE '^[[:space:]]*MaxSessions' "$ACCESS_SSHD_CONFIG" | tail -1 | awk '{print $2}')"
  grace="$(grep -iE '^[[:space:]]*LoginGraceTime' "$ACCESS_SSHD_CONFIG" | tail -1 | awk '{print $2}')"
  say "  MaxStartups=${startups:-unset (default 10:30:100)} MaxSessions=${sessions:-unset (default 10)} LoginGraceTime=${grace:-unset (default 120)}"
  if [ -z "$startups" ]; then
    found "MaxStartups is unset, so the default 10:30:100 applies: random early drop begins at 10 concurrent unauthenticated connections, which parallel ops scripts reach easily" \
          "MaxStartups 30:30:100 in $ACCESS_SSHD_CONFIG, then sshd -t && systemctl reload ssh   # keep a session open"
  else
    ok "MaxStartups is set explicitly ($startups)"
  fi
else
  skip "sshd config: $ACCESS_SSHD_CONFIG is not readable (run as root to check it)"
fi
say ""

if [ -n "$unverified" ]; then
  say "NOT VERIFIED"
  say "$unverified"
  say ""
fi

if [ "$findings" = "0" ]; then
  if [ -n "$unverified" ]; then
    say "no findings in what could be checked, but the audit was INCOMPLETE"
    exit 2
  fi
  say "no findings: exposure matches intent and sshd throttling is explicit"
  exit 0
fi
say "$findings finding(s). Nothing was changed. Apply fixes one at a time with a session already open."
exit 1
