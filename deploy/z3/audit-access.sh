#!/usr/bin/env bash
# Reports what this box exposes and how sshd is throttling. Read-only, applies
# nothing: the box has one door and a lockout is a dead box. See OPERATIONS.md.
set -uo pipefail

# Public by intent: ssh, http, https, and Zebra's P2P port, where inbound peers
# are the point. Everything else must be loopback or docker-internal, above all
# the node RPC and the wallet RPC.
ACCESS_PUBLIC_PORTS="${ACCESS_PUBLIC_PORTS:-22 80 443 18233 8233}"
# THE THIRD CASE, and it exists because the crosslink node forced it. These
# ports are bound wide by software we do not control and are deliberately NOT
# public: the firewall is the whole control, not the bind.
#
#   19233  crosslink P2P, binds [::] as shipped. We take outbound peers only.
#   29234  crosslink zaino gRPC, binds 0.0.0.0 as shipped and has no config key
#          to move it. Issue #322 called for forcing it to loopback; their build
#          offers no way, so ufw is what holds it.
#
# Before this list existed the audit had two categories, so these two came back
# as findings on every run - five findings a night, three of them permanent. A
# report that is always wrong about the same things is how a real finding gets
# skipped, and this box has no alert delivery (#215) so the log is the only
# place either would appear.
#
# Silencing them would be the easy version and the wrong one. Listing a port
# here does not excuse it: it MOVES the assertion from the bind to the firewall,
# and the firewall section below now checks that ufw really denies each one.
# An allow rule appearing for a port in this list is a finding of its own.
ACCESS_FIREWALLED_PORTS="${ACCESS_FIREWALLED_PORTS:-19233 29234}"
ACCESS_SSHD_CONFIG="${ACCESS_SSHD_CONFIG:-/etc/ssh/sshd_config}"
# sshd -T resolves Include directives and reports what sshd will actually
# enforce. Grepping the main file misses sshd_config.d drop-ins, which win.
ACCESS_SSHD="${ACCESS_SSHD:-sshd}"
ACCESS_SS="${ACCESS_SS:-ss}"
ACCESS_UFW="${ACCESS_UFW:-ufw}"
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

findings=0
unverified=""
# Ports that are BOTH intended-public and actually listening. A ufw rule for a
# port nothing serves is not a finding, and the mainnet P2P port on a testnet
# box is exactly that case.
listening_public=""
# Same idea for the firewalled-by-intent set: a port nothing serves needs no
# check, and checking one would report on a socket that does not exist.
listening_firewalled=""
say()   { echo "$*"; }
ok()    { [ "$VERBOSE" = "1" ] && echo "  ok       $*"; return 0; }
found() { findings=$((findings + 1)); echo "  FINDING  $1"; [ -n "${2:-}" ] && echo "           fix: $2"; return 0; }
skip()  { unverified="${unverified}${unverified:+
}  - $1"; }

is_public_port() { case " $ACCESS_PUBLIC_PORTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
is_firewalled_port() { case " $ACCESS_FIREWALLED_PORTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

say "access audit for $(hostname 2>/dev/null || echo this box)"
say ""

say "listening sockets reachable from off-box"
if command -v "$ACCESS_SS" >/dev/null 2>&1; then
  # Wildcard binds (0.0.0.0 or ::) are reachable unless the firewall says no.
  while read -r addr port; do
    [ -n "${port:-}" ] || continue
    # THE WHOLE 127.0.0.0/8 IS LOOPBACK, not just 127.0.0.1. systemd-resolved
    # listens on 127.0.0.54, and this line used to match only the .1, so the box
    # has reported "port 53 is bound on 127.0.0.54, which is off-box reachable"
    # every night since the audit shipped. It is not reachable and never was.
    case "$addr" in
      127.*|::1|localhost) continue ;;
    esac
    if is_public_port "$port"; then
      case " $listening_public " in *" $port "*) ;; *) listening_public="$listening_public $port" ;; esac
      ok "port $port on $addr is public by intent"
    elif is_firewalled_port "$port"; then
      case " $listening_firewalled " in *" $port "*) ;; *) listening_firewalled="$listening_firewalled $port" ;; esac
      ok "port $port on $addr is bound wide but firewalled by intent, checked below"
    else
      found "port $port is bound on $addr, which is off-box reachable and not in the intended set ($ACCESS_PUBLIC_PORTS)" \
            "if it is a docker-published port, REBIND it to 127.0.0.1 (docker writes its own iptables chain, so ufw deny will not close it). Host services: bind to 127.0.0.1 or ufw deny $port/tcp"
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
      found "ufw is rate-limiting SSH (LIMIT, hardcoded 6 connections per 30s per source), which drops bursts of parallel connections and surfaces as kex_exchange_identification resets" \
            "prefer client-side multiplexing, which needs no box change (see OPERATIONS.md). 'ufw allow OpenSSH' also fixes it but REMOVES brute-force limiting from a public port, so only with keys-only auth and fail2ban"
    fi
    for p in $listening_public; do
      printf '%s' "$ufw_out" | grep -qE "(^|[^0-9])$p(/tcp)?[[:space:]]" \
        || found "port $p is serving and intended to be public but has no ufw rule" "ufw allow $p/tcp"
    done
    [ -n "$listening_public" ] || skip "which public ports need a ufw rule: no listening sockets were read, so rules were not cross-checked"
    # The other direction, and the reason the firewalled list is not just a mute
    # button: these ports are wide open at the bind, so an ALLOW rule for one is
    # a public wallet-adjacent socket the moment it appears. ufw's default-deny
    # is doing the work, and this asserts it is still doing it.
    for p in $listening_firewalled; do
      if printf '%s' "$ufw_out" | grep -qiE "(^|[^0-9])$p(/tcp)?[[:space:]]+ALLOW"; then
        found "port $p has a ufw ALLOW rule, and it is bound wide - the firewall was the only thing keeping it off the internet" \
              "ufw delete allow $p/tcp, then confirm from OFF the box that it is closed"
      else
        ok "port $p is bound wide but ufw has no allow rule for it"
      fi
    done
  else
    found "ufw is installed but NOT active, so nothing is filtered" \
          "ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable   # keep a session open while doing this"
    # Named separately because the generic finding above understates it: for
    # these ports the firewall is not defence in depth, it is the only layer.
    for p in $listening_firewalled; do
      found "port $p is bound wide and ufw is INACTIVE, so it is reachable from the internet right now" \
            "re-enable ufw (above). These ports cannot be rebound: their listener has no config key for it"
    done
  fi
else
  skip "firewall: no $ACCESS_UFW on this host"
  [ -z "$listening_firewalled" ] || skip "whether$listening_firewalled are closed: they are bound wide and the firewall is their only control, and it could not be read"
fi
say ""

# The connection resets that have cost every ops loop retries tonight. sshd
# drops unauthenticated connections early once MaxStartups is reached, and the
# client reports it as kex_exchange_identification.
say "sshd connection throttling"
# Ask sshd, do not grep. On Ubuntu 24.04 sshd_config's first directive is
# Include /etc/ssh/sshd_config.d/*.conf and the FIRST value obtained wins, so a
# drop-in silently beats the main file. Reading the main file alone can report
# unset when a drop-in has set it, and would send an edit to a file that has no
# effect.
sshd_source=""
effective=""
if command -v "$ACCESS_SSHD" >/dev/null 2>&1 && effective="$("$ACCESS_SSHD" -T 2>/dev/null)" && [ -n "$effective" ]; then
  sshd_source="effective config from $ACCESS_SSHD -T"
  startups="$(printf '%s\n' "$effective" | awk 'tolower($1)=="maxstartups"{print $2; exit}')"
  sessions="$(printf '%s\n' "$effective" | awk 'tolower($1)=="maxsessions"{print $2; exit}')"
  grace="$(printf '%s\n' "$effective" | awk 'tolower($1)=="logingracetime"{print $2; exit}')"
elif [ -r "$ACCESS_SSHD_CONFIG" ]; then
  sshd_source="$ACCESS_SSHD_CONFIG only, Include directives NOT resolved"
  startups="$(grep -iE '^[[:space:]]*MaxStartups' "$ACCESS_SSHD_CONFIG" | tail -1 | awk '{print $2}')"
  sessions="$(grep -iE '^[[:space:]]*MaxSessions' "$ACCESS_SSHD_CONFIG" | tail -1 | awk '{print $2}')"
  grace="$(grep -iE '^[[:space:]]*LoginGraceTime' "$ACCESS_SSHD_CONFIG" | tail -1 | awk '{print $2}')"
  if grep -qiE '^[[:space:]]*Include' "$ACCESS_SSHD_CONFIG"; then
    skip "whether a drop-in overrides these: $ACCESS_SSHD_CONFIG has an Include and $ACCESS_SSHD -T could not be run, so any value below may be overridden and an edit here may have no effect"
  fi
else
  skip "sshd throttling: neither $ACCESS_SSHD -T nor $ACCESS_SSHD_CONFIG could be read (run as root)"
fi

if [ -n "$sshd_source" ]; then
  say "  source: $sshd_source"
  say "  MaxStartups=${startups:-unset (default 10:30:100)} MaxSessions=${sessions:-unset (default 10)} LoginGraceTime=${grace:-unset (default 120)}"
  if [ -z "$startups" ]; then
    found "MaxStartups is unset, so the default 10:30:100 applies: random early drop begins at 10 concurrent unauthenticated connections, which parallel ops scripts reach easily" \
          "first try client-side multiplexing (no box change, see OPERATIONS.md). If a server change is still wanted, set MaxStartups 30:30:100 where $ACCESS_SSHD -T says it comes from, then $ACCESS_SSHD -t && systemctl reload ssh, with a session already open"
  else
    ok "MaxStartups is set explicitly ($startups)"
  fi
fi

# Socket activation changes who owns the listening socket, and therefore
# whether a reload picks a change up at all.
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-enabled --quiet ssh.socket 2>/dev/null; then
    say "  ssh.socket is ENABLED: systemd owns the listening socket, so confirm a reload actually applies a change before trusting it"
  else
    ok "ssh.socket is not enabled, sshd owns its own socket"
  fi
else
  skip "socket activation: no systemctl on this host"
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
