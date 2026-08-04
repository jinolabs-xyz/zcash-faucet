# shellcheck shell=bash
# audit-access.sh: what this box exposes, and how sshd throttles. Read-only.
# ss, ufw and the sshd config are all injected, so no privileges are needed.

AUDIT_A="$REPO/deploy/z3/audit-access.sh"

access_env() {
  mk_scratch "${TMPDIR:-/tmp}/access-test.XXXXXX"
  export STUB_LISTEN="$T/listen" STUB_UFW_STATUS="$T/ufw"
  export ACCESS_SS="$SCRATCH/stubs/access-ss" ACCESS_UFW="$SCRATCH/stubs/access-ufw"
  export ACCESS_SSHD_CONFIG="$T/sshd_config"
  export ACCESS_SSHD="$SCRATCH/stubs/access-sshd" STUB_SSHD_T="$T/sshd_effective"
  : > "$T/sshd_effective"
  : > "$STUB_LISTEN"; : > "$STUB_UFW_STATUS"; : > "$ACCESS_SSHD_CONFIG"
  export PATH="$BASE_PATH"
}
ufw_active() { printf 'Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere\n80/tcp                     ALLOW       Anywhere\n443/tcp                    ALLOW       Anywhere\n' > "$STUB_UFW_STATUS"; }

echo "== access: a box matching the intended exposure reports nothing"
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n127.0.0.1:3000\n127.0.0.1:18232\n' > "$STUB_LISTEN"
ufw_active
echo 'MaxStartups 30:30:100' > "$ACCESS_SSHD_CONFIG"
bash "$AUDIT_A" > "$T/clean.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "says no findings" "grep -q 'no findings' '$T/clean.log'"
check "loopback-only ports are not flagged" "! grep -q '3000' '$T/clean.log'"
check "the node RPC on loopback is not flagged" "! grep -q '18232' '$T/clean.log'"

echo "== access: a publicly bound RPC port is the finding that matters"
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n0.0.0.0:18232\n' > "$STUB_LISTEN"
ufw_active; echo 'MaxStartups 30:30:100' > "$ACCESS_SSHD_CONFIG"
bash "$AUDIT_A" > "$T/rpc.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "names the exposed port" "grep -q 'port 18232 is bound on 0.0.0.0' '$T/rpc.log'"
check "offers a fix" "grep -q 'ufw deny 18232/tcp' '$T/rpc.log'"

echo "== access: ufw installed but inactive means nothing is filtered"
access_env
printf '0.0.0.0:22\n' > "$STUB_LISTEN"
printf 'Status: inactive\n' > "$STUB_UFW_STATUS"
echo 'MaxStartups 30:30:100' > "$ACCESS_SSHD_CONFIG"
bash "$AUDIT_A" > "$T/inactive.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "says nothing is filtered" "grep -q 'NOT active, so nothing is filtered' '$T/inactive.log'"
check "the fix keeps a session open" "grep -q 'keep a session open' '$T/inactive.log'"

echo "== access: ufw LIMIT on ssh is named as a cause of kex resets"
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n' > "$STUB_LISTEN"
printf 'Status: active\n\n22/tcp                     LIMIT       Anywhere\n80/tcp                     ALLOW       Anywhere\n443/tcp                    ALLOW       Anywhere\n' > "$STUB_UFW_STATUS"
echo 'MaxStartups 30:30:100' > "$ACCESS_SSHD_CONFIG"
bash "$AUDIT_A" > "$T/limit.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "connects LIMIT to the reset symptom" "grep -q 'kex_exchange_identification' '$T/limit.log'"
check "the fix replaces LIMIT with allow" "grep -q 'ufw allow OpenSSH' '$T/limit.log'"

echo "== access: an intended port with no rule is a finding"
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n' > "$STUB_LISTEN"
printf 'Status: active\n\n22/tcp                     ALLOW       Anywhere\n80/tcp                     ALLOW       Anywhere\n' > "$STUB_UFW_STATUS"
echo 'MaxStartups 30:30:100' > "$ACCESS_SSHD_CONFIG"
bash "$AUDIT_A" > "$T/missing.log" 2>&1
check "443 with no rule is reported" "grep -q 'port 443 is serving and intended to be public but has no ufw rule' '$T/missing.log'"

echo "== access: an unset MaxStartups is reported with the real default"
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n' > "$STUB_LISTEN"
ufw_active
: > "$ACCESS_SSHD_CONFIG"
bash "$AUDIT_A" > "$T/startups.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "names the 10:30:100 default" "grep -q '10:30:100' '$T/startups.log'"
check "explains parallel ops connections reach it" "grep -q 'parallel ops scripts reach easily' '$T/startups.log'"
check "the fix reloads rather than restarts" "grep -q 'systemctl reload ssh' '$T/startups.log'"

echo "== access: what cannot be checked is NOT VERIFIED, never a pass"
access_env
export ACCESS_SS="$T/no-such-ss" ACCESS_UFW="$T/no-such-ufw"
export ACCESS_SSHD_CONFIG="$T/no-such-config"
bash "$AUDIT_A" > "$T/unver.log" 2>&1
check "exits 2, not 0" "[ $? -eq 2 ]"
check "prints NOT VERIFIED" "grep -q 'NOT VERIFIED' '$T/unver.log'"
check "names all three skipped checks" "[ \"\$(grep -c '^  - ' '$T/unver.log')\" = '3' ]"
check "never claims exposure matches intent" "! grep -q 'no findings: exposure matches intent' '$T/unver.log'"

echo "== access: it is read-only, it applies nothing"
access_env
printf '0.0.0.0:18232\n' > "$STUB_LISTEN"; ufw_active
# shellcheck disable=SC2034
before="$(cat "$STUB_UFW_STATUS")"
bash "$AUDIT_A" > /dev/null 2>&1
check "the firewall state was not touched" "[ \"\$before\" = \"\$(cat '$STUB_UFW_STATUS')\" ]"
# The fix strings mention ufw allow, which is correct. What must never appear
# is a mutating verb actually invoked on the ufw binary.
check "ufw is never invoked with a mutating verb" "! grep -qE '\"[$]ACCESS_UFW\"[[:space:]]+(allow|deny|enable|disable|reset|limit)' '$AUDIT_A'"

echo "== access: the effective config wins over the main file (SDE-App's HIGH)"
# On 24.04 sshd_config's first directive is Include sshd_config.d/*.conf and the
# FIRST value wins, so grepping the main file can report unset when a drop-in
# has set it, and would send an edit to a file that has no effect.
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n' > "$STUB_LISTEN"; ufw_active
printf 'Include /etc/ssh/sshd_config.d/*.conf\n' > "$ACCESS_SSHD_CONFIG"   # main file: no MaxStartups
printf 'maxstartups 30:30:100\nmaxsessions 10\nlogingracetime 120\n' > "$STUB_SSHD_T"
bash "$AUDIT_A" > "$T/eff.log" 2>&1
check "exits 0: the drop-in value is found" "[ $? -eq 0 ]"
check "says the number came from sshd -T" "grep -q 'source: effective config from' '$T/eff.log'"
check "reports the drop-in value, not unset" "grep -q 'MaxStartups=30:30:100' '$T/eff.log'"
check "does NOT claim MaxStartups is unset" "! grep -q 'MaxStartups is unset' '$T/eff.log'"

echo "== access: without sshd -T it says the value may be overridden"
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n' > "$STUB_LISTEN"; ufw_active
printf 'Include /etc/ssh/sshd_config.d/*.conf\nMaxStartups 10:30:100\n' > "$ACCESS_SSHD_CONFIG"
: > "$STUB_SSHD_T"        # sshd -T unavailable, forcing the fallback
bash "$AUDIT_A" > "$T/fallback.log" 2>&1
rc_fb=$?
check "labels the weaker source" "grep -q 'Include directives NOT resolved' '$T/fallback.log'"
check "warns an edit there may have no effect" "grep -q 'may have no effect' '$T/fallback.log'"
check "exits 2, because the answer is not trustworthy" "[ $rc_fb -eq 2 ]"

echo "== access: the ufw fix states what it costs"
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n' > "$STUB_LISTEN"
printf 'Status: active\n\n22/tcp                     LIMIT       Anywhere\n80/tcp                     ALLOW       Anywhere\n443/tcp                    ALLOW       Anywhere\n' > "$STUB_UFW_STATUS"
printf 'maxstartups 30:30:100\n' > "$STUB_SSHD_T"
bash "$AUDIT_A" > "$T/trade.log" 2>&1
check "names the hardcoded 6-per-30s limit" "grep -q '6 connections per 30s per source' '$T/trade.log'"
check "recommends the client-side fix first" "grep -q 'prefer client-side multiplexing' '$T/trade.log'"
check "says allow REMOVES brute-force limiting" "grep -q 'REMOVES brute-force limiting' '$T/trade.log'"
check "names the compensating controls" "grep -q 'keys-only auth and fail2ban' '$T/trade.log'"

echo "== access: P2P is public by intent, RPC ports never are"
# Found while doing the loopback rebinding: the audit flagged Zebra's P2P port,
# which must be reachable for inbound peers. A false positive on a port that
# should stay open teaches operators to close the wrong thing.
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n0.0.0.0:18233\n127.0.0.1:18232\n127.0.0.1:40232\n' > "$STUB_LISTEN"
printf 'Status: active\n\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n18233/tcp ALLOW Anywhere\n' > "$STUB_UFW_STATUS"
printf 'maxstartups 30:30:100\n' > "$STUB_SSHD_T"
bash "$AUDIT_A" > "$T/p2p.log" 2>&1
check "exits 0 with P2P public and RPC on loopback" "[ $? -eq 0 ]"
check "P2P is not flagged" "! grep -q '18233' '$T/p2p.log'"
check "loopback node RPC is not flagged" "! grep -q '18232' '$T/p2p.log'"
check "loopback wallet RPC is not flagged" "! grep -q '40232' '$T/p2p.log'"

echo "== access: 127.0.0.0/8 is loopback, not just 127.0.0.1"
# systemd-resolved listens on 127.0.0.54. The address test matched only the .1,
# so the live box reported "port 53 is bound on 127.0.0.54, which is off-box
# reachable" on every run since this audit shipped. Three permanent findings a
# night is how a real one gets skipped.
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n127.0.0.54:53\n127.0.0.53:53\n' > "$STUB_LISTEN"
ufw_active; printf 'maxstartups 30:30:100\n' > "$STUB_SSHD_T"
bash "$AUDIT_A" > "$T/loopback8.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "127.0.0.54 is not called off-box reachable" "! grep -q '127.0.0.54' '$T/loopback8.log'"
check "and no finding was invented for port 53" "! grep -q 'port 53' '$T/loopback8.log'"

echo "== access: a port bound wide but firewalled by intent is not a finding"
# The crosslink node binds its P2P on [::] and zaino's gRPC on 0.0.0.0, and
# neither has a config key to move it. #322 asked for a loopback bind; the
# firewall is what we actually have.
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n0.0.0.0:29234\n[::]:19233\n' > "$STUB_LISTEN"
ufw_active; printf 'maxstartups 30:30:100\n' > "$STUB_SSHD_T"
bash "$AUDIT_A" > "$T/fw.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "the gRPC port is not a finding" "! grep -q 'FINDING.*29234' '$T/fw.log'"
check "the crosslink P2P port is not a finding" "! grep -q 'FINDING.*19233' '$T/fw.log'"

echo "== access: and listing one MOVES the check to the firewall, it does not mute it"
# The half that makes the list above safe. If it only silenced the port, a later
# 'ufw allow 29234' would open a wallet-adjacent socket to the internet and the
# audit would say nothing, which is worse than the noise it replaced.
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n0.0.0.0:29234\n' > "$STUB_LISTEN"
printf 'Status: active\n\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n29234/tcp ALLOW Anywhere\n' > "$STUB_UFW_STATUS"
printf 'maxstartups 30:30:100\n' > "$STUB_SSHD_T"
bash "$AUDIT_A" > "$T/fwallow.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "an allow rule on a bound-wide port is the finding" "grep -q 'port 29234 has a ufw ALLOW rule' '$T/fwallow.log'"
check "says the firewall was the only thing holding it" "grep -q 'only thing keeping it off the internet' '$T/fwallow.log'"

echo "== access: ufw inactive names each bound-wide port, not just the general case"
access_env
printf '0.0.0.0:22\n0.0.0.0:29234\n' > "$STUB_LISTEN"
printf 'Status: inactive\n' > "$STUB_UFW_STATUS"
printf 'maxstartups 30:30:100\n' > "$STUB_SSHD_T"
bash "$AUDIT_A" > "$T/fwoff.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "names the port, not only 'nothing is filtered'" "grep -q 'port 29234 is bound wide and ufw is INACTIVE' '$T/fwoff.log'"
check "says it is reachable right now" "grep -q 'reachable from the internet right now' '$T/fwoff.log'"

echo "== access: an unreadable firewall makes those ports NOT VERIFIED, never ok"
access_env
printf '0.0.0.0:29234\n' > "$STUB_LISTEN"
export ACCESS_UFW="$T/no-such-ufw"
printf 'maxstartups 30:30:100\n' > "$STUB_SSHD_T"
bash "$AUDIT_A" > "$T/fwunver.log" 2>&1
check "exits 2, not 0" "[ $? -eq 2 ]"
check "the port is listed as unverified" "grep -q 'they are bound wide and the firewall is their only control' '$T/fwunver.log'"
check "and is never reported as ok" "! grep -q 'no allow rule for it' '$T/fwunver.log'"

echo "== access: a publicly bound WALLET rpc is the worst case, and says why ufw cannot fix it"
access_env
printf '0.0.0.0:22\n0.0.0.0:80\n0.0.0.0:443\n0.0.0.0:40232\n' > "$STUB_LISTEN"; ufw_active
printf 'maxstartups 30:30:100\n' > "$STUB_SSHD_T"
bash "$AUDIT_A" > "$T/wallet.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "flags the wallet RPC" "grep -q 'port 40232 is bound on 0.0.0.0' '$T/wallet.log'"
check "says rebind, because docker bypasses ufw" "grep -q 'docker writes its own iptables chain' '$T/wallet.log'"
