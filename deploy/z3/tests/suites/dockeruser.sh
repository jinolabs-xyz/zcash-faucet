# shellcheck shell=bash
# docker-user-rules.sh: the DOCKER-USER DROP rules for the RPC-class ports, idempotent, both
# families, never a public port. iptables and ip6tables are one recording stub each.

DU="$REPO/deploy/z3/docker-user-rules.sh"

du_env() {
  mk_scratch "${TMPDIR:-/tmp}/dockeruser-test.XXXXXX"
  export STUB_IPT_LOG="$T/ipt.log" STUB_IPT_RULES="$T/ipt.rules"; : > "$STUB_IPT_LOG"; : > "$STUB_IPT_RULES"
  # Two wrappers so the family is recorded with every call: the same stub, one env each.
  printf '#!/usr/bin/env bash\nSTUB_IPT_FAMILY=v4 exec "%s/stubs/docker-user-iptables" "$@"\n' "$SCRATCH" > "$T/iptables"
  printf '#!/usr/bin/env bash\nSTUB_IPT_FAMILY=v6 exec "%s/stubs/docker-user-iptables" "$@"\n' "$SCRATCH" > "$T/ip6tables"
  chmod +x "$T/iptables" "$T/ip6tables"
  export DOCKER_USER_IPTABLES="$T/iptables" DOCKER_USER_IP6TABLES="$T/ip6tables"
  unset FAUCET_WAN_IFACE FAUCET_RPC_PORTS STUB_IPT_FAIL_INSERT 2>/dev/null || true
}
rules_for() { grep -c "^$1 " "$STUB_IPT_RULES"; }   # rules present for a family

echo "== docker-user: the first run drops every RPC-class port on the WAN interface, both families"
du_env
bash "$DU" > "$T/run1.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "ten ports, ten v4 rules" "[ \"\$(rules_for v4)\" = 10 ]"
check "and ten v6 rules" "[ \"\$(rules_for v6)\" = 10 ]"
check "each rule matches the ORIGINAL destination port on eth0 and DROPs" \
  "[ \"\$(grep -c -- '-I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport [0-9]* -j DROP' '$STUB_IPT_LOG')\" = 20 ]"
check "the wallet RPC is among them" "grep -q -- '--ctorigdstport 40232 -j DROP' '$STUB_IPT_RULES'"
check "and the journal counts what it did" "grep -q 'DOCKER-USER: 20 rule(s) added, 0 already present' '$T/run1.log'"

echo "== docker-user: a second run adds NOTHING - idempotent, so boot, docker restart and install-ops can all run it"
bash "$DU" > "$T/run2.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "still ten and ten" "[ \"\$(rules_for v4)\" = 10 ] && [ \"\$(rules_for v6)\" = 10 ]"
check "no -I was issued the second time" "[ \"\$(grep -c -- ' -I ' '$STUB_IPT_LOG')\" = 20 ]"
check "and the journal says so" "grep -q 'DOCKER-USER: 0 rule(s) added, 20 already present' '$T/run2.log'"

echo "== docker-user: never a public port - 22, 80, 443 and P2P are not in the list, and the list is read from the file"
du_env
bash "$DU" > /dev/null 2>&1
for p in 22 80 443 18233 8233; do
  check "no rule names port $p" "! grep -q -- \"--ctorigdstport $p \" '$STUB_IPT_RULES'"
done
check "the shipped list is exactly the six RPC-class ports of both networks plus zaino's four" \
  "grep -q '^RPC_PORTS=\"\${FAUCET_RPC_PORTS:-18232 18080 40232 18137 18237 8232 8080 28232 8137 8237}\"' '$DU'"

echo "== docker-user: the interface is a knob, because eth0 is this box's name and not every box's"
du_env
FAUCET_WAN_IFACE=ens3 bash "$DU" > /dev/null 2>&1
check "rules land on the named interface" "[ \"\$(grep -c -- '-i ens3 ' '$STUB_IPT_RULES')\" = 20 ] && ! grep -q -- '-i eth0 ' '$STUB_IPT_RULES'"

echo "== docker-user: a missing ip6tables is an ERROR for that family, not a quiet v4-only pass"
du_env
export DOCKER_USER_IP6TABLES="$T/no-such-ip6tables"
bash "$DU" > "$T/nov6.log" 2>&1
check "exits non-zero" "[ $? -ne 0 ]"
check "v4 rules are still written" "[ \"\$(rules_for v4)\" = 10 ]"
check "and the journal names the family left unprotected" "grep -q 'ERROR: .*no-such-ip6tables is not installed, so the RPC ports are NOT protected on that family' '$T/nov6.log'"

echo "== docker-user: an insert that fails is an ERROR naming the port, and the run is not green"
du_env
STUB_IPT_FAIL_INSERT=1 bash "$DU" > "$T/insfail.log" 2>&1
check "exits non-zero" "[ $? -ne 0 ]"
check "names a port it could not add" "grep -q 'ERROR: .* could not add the DROP for port 18232 on eth0' '$T/insfail.log'"
check "and says no rule is in place rather than counting zero as done" "grep -q 'ERROR: no rule is in place' '$T/insfail.log'"

echo "== docker-user: the unit is declared, re-runs on a docker restart, and is what install-ops installs"
check "enabled-units declares the service" "grep -qx 'faucet-docker-user.service' <(sed 's/#.*//; s/[[:space:]]//g' '$REPO/deploy/z3/enabled-units')"
check "the unit is PartOf docker.service, so a docker restart re-applies the rules" \
  "grep -qx 'PartOf=docker.service' '$REPO/deploy/z3/faucet-docker-user.service'"
check "and runs the installed script" "grep -qx 'ExecStart=/opt/faucet/docker-user-rules.sh' '$REPO/deploy/z3/faucet-docker-user.service'"
