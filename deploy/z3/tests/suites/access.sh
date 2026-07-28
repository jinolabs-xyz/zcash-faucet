# shellcheck shell=bash
# audit-access.sh: what this box exposes, and how sshd throttles. Read-only.
# ss, ufw and the sshd config are all injected, so no privileges are needed.

AUDIT_A="$REPO/deploy/z3/audit-access.sh"

access_env() {
  T="$(mktemp -d "${TMPDIR:-/tmp}/access-test.XXXXXX")"
  export STUB_LISTEN="$T/listen" STUB_UFW_STATUS="$T/ufw"
  export ACCESS_SS="$SCRATCH/stubs/access-ss" ACCESS_UFW="$SCRATCH/stubs/access-ufw"
  export ACCESS_SSHD_CONFIG="$T/sshd_config"
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
check "443 with no rule is reported" "grep -q 'port 443 is intended to be public but has no ufw rule' '$T/missing.log'"

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
