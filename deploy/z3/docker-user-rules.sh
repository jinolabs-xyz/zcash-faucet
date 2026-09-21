#!/usr/bin/env bash
# Keeps the RPC-class ports the z3 stack publishes closed from the internet, durably.
#
# WHY A UNIT AND NOT A HAND-RUN RULE. Docker publishes a container port by writing its own
# iptables chains, and those sit BEFORE ufw's, so `ufw deny` never sees the packet: the only
# firewall rule docker honours is one placed in the DOCKER-USER chain, which docker jumps to
# first and never edits. That rule was put there by hand in August 2026 and it did not survive:
# on 2026-09-21 `iptables -S DOCKER-USER` printed only the chain header, and zebra's RPC, its
# health port and the WALLET RPC had been reachable from the internet for a month (the access
# audit said so 34 times). A rule that lives in a running kernel lives until the next reboot;
# this file lives in the repo, install-ops installs it, enabled-units enables its unit, and the
# unit is PartOf docker.service so a docker restart re-applies it too.
#
# WHAT IT IS NOT. It is the second line, not the first: the first is deploy.sh binding every
# RPC-class port to 127.0.0.1 in the generated override, so docker never publishes them on
# 0.0.0.0 at all. This exists for the day someone runs compose by hand in the clone again (the
# 2026-08-30 upgrade did) and the binding is lost until the next deploy.sh.
#
# `-m conntrack --ctorigdstport` and not `--dport`: by the time a packet reaches DOCKER-USER,
# docker's DNAT has already rewritten the destination port to the container's (28232 for the
# wallet), so the host port is only visible as the ORIGINAL destination of the connection.
# Matching on the interface keeps this to the internet side: faucet->zallet is bridge to
# bridge and the watchdog->zebra is loopback, neither crosses the WAN interface.
#
# Idempotent: -C first, -I only when absent, so a re-run (boot, docker restart, install-ops)
# adds nothing twice. Never touches a public port: 22, 80, 443 and the P2P ports are not in
# the list and the repo suite holds that.
set -uo pipefail

log() { echo "$(date -u +%FT%TZ) docker-user-rules: $*"; }

WAN_IFACE="${FAUCET_WAN_IFACE:-eth0}"
# Testnet and mainnet numbers both: a box switches network by env, and a rule for the other
# network's ports costs nothing while it drops nothing.
RPC_PORTS="${FAUCET_RPC_PORTS:-18232 18080 40232 18137 18237 8232 8080 28232 8137 8237}"
IPT4="${DOCKER_USER_IPTABLES:-iptables}"
IPT6="${DOCKER_USER_IP6TABLES:-ip6tables}"

rc=0; added=0; present=0
for ipt in "$IPT4" "$IPT6"; do
  if ! command -v "$ipt" >/dev/null 2>&1; then
    log "ERROR: $ipt is not installed, so the RPC ports are NOT protected on that family"
    rc=1; continue
  fi
  # Docker creates DOCKER-USER when it starts; creating it here when docker has not yet is
  # harmless (docker keeps an existing chain) and lets the rules land before the first jump.
  "$ipt" -N DOCKER-USER 2>/dev/null || true
  for port in $RPC_PORTS; do
    if "$ipt" -C DOCKER-USER -i "$WAN_IFACE" -p tcp -m conntrack --ctorigdstport "$port" -j DROP 2>/dev/null; then
      present=$((present + 1))
    elif "$ipt" -I DOCKER-USER -i "$WAN_IFACE" -p tcp -m conntrack --ctorigdstport "$port" -j DROP; then
      added=$((added + 1))
    else
      log "ERROR: $ipt could not add the DROP for port $port on $WAN_IFACE"
      rc=1
    fi
  done
done
log "DOCKER-USER: $added rule(s) added, $present already present, on $WAN_IFACE for ports: $RPC_PORTS"
# A run that protected nothing must not read as a run that did. Counts are the evidence.
[ $((added + present)) -gt 0 ] || { log "ERROR: no rule is in place"; rc=1; }
exit $rc
