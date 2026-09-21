# shellcheck shell=bash
# drift-report.sh: the wrapper that runs the audits, pages on a CHANGE in what they found,
# and publishes counts for box-report to carry to /api/status. Both audits are stubbed by
# path (DRIFT_AUDIT, DRIFT_ACCESS_AUDIT): what they print and what they exit is the
# fixture; alert.sh is a recorder.

DR="$REPO/deploy/z3/drift-report.sh"

dr_env() {
  mk_scratch "${TMPDIR:-/tmp}/driftreport-test.XXXXXX"
  mkdir -p "$T/bin" "$T/state" "$T/repo"
  export DRIFT_STATE_DIR="$T/state"
  export DRIFT_AUDIT="$T/bin/audit-drift" DRIFT_ACCESS_AUDIT="$T/bin/audit-access" DRIFT_ALERT_SH="$T/bin/alert"
  export DRIFT_RUN_ACCESS=1
  # A checkout with a commit, so repoSha is a real 40-hex sha and not a placeholder.
  git -C "$T/repo" init -q && git -C "$T/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m fixture
  export AUDIT_REPO_DIR="$T/repo"
  export PAGES="$T/pages"; : > "$PAGES"
  # alert.sh recorder: one line per page; STUB_ALERT_FAIL=1 refuses, like a dead webhook.
  cat > "$T/bin/alert" <<'STUB'
#!/usr/bin/env bash
[ "${STUB_ALERT_FAIL:-0}" = "1" ] && { echo "stub alert: refusing" >&2; exit 1; }
printf '%s\n' "$1" >> "${PAGES:?}"
STUB
  chmod +x "$T/bin/alert"
  audit_says "$T/bin/audit-drift" 0 ""
  audit_says "$T/bin/audit-access" 0 ""
}
# audit_says <path> <rc> <body>: the stub prints the body verbatim and exits rc.
audit_says() {
  printf '#!/usr/bin/env bash\ncat <<"OUT"\n%s\nOUT\nexit %s\n' "$3" "$2" > "$1"; chmod +x "$1"
}
DRIFT2='auditing box
  DRIFT    faucet.env is mode 644, readable by every user
           fix: chmod 0600
  DRIFT    faucet-thing.timer is DECLARED in enabled-units but NOT enabled
           fix: systemctl enable --now faucet-thing.timer
DRIFT FOUND. The fix is to put these into the repo, not to change the box:'
DRIFT2B='auditing box
  DRIFT    faucet.env is mode 644, readable by every user
           fix: chmod 0600
  DRIFT    watchdog.sh differs from the repo copy
           fix: diff
DRIFT FOUND. The fix is to put these into the repo, not to change the box:'
INCOMPLETE1='auditing box
NOT VERIFIED
  - whether any unit is ENABLED: no systemctl on this host
no drift found in what could be checked, but the audit was INCOMPLETE (see NOT VERIFIED)'
summary() { cat "$T/state/summary.json" 2>/dev/null; }
field() { # $1 audit, $2 field -> number
  summary | grep -oE "\"$1\":\{[^}]*\}" | grep -oE "\"$2\":[0-9]+" | cut -d: -f2
}

echo "== drift-report: a clean run publishes a summary of zeros, with the checkout's sha, and pages nothing"
dr_env
bash "$DR" > "$T/run1.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "the summary exists and is ONE line of the fixed shape box-report accepts" \
  "[ \"\$(wc -l < '$T/state/summary.json')\" -eq 1 ] && summary | grep -qE '^\\{\"at\":[0-9]+,\"repoSha\":\"[0-9a-f]{40}\",\"config\":\\{\"rc\":0,\"findings\":0,\"unverified\":0\\},\"access\":\\{\"rc\":0,\"findings\":0,\"unverified\":0\\}\\}$'"
check "and the sha is the checkout's HEAD, not a placeholder" \
  "summary | grep -qF \"\$(git -C '$T/repo' rev-parse HEAD)\""
check "and nothing was paged" "[ ! -s '$PAGES' ]"

echo "== drift-report: findings page ONCE, with the count, and the same findings next run page nothing"
dr_env
audit_says "$T/bin/audit-drift" 1 "$DRIFT2"
bash "$DR" > "$T/run1.log" 2>&1
check "first sight pages, naming the count" "grep -q 'config findings CHANGED on .*: 2 now\\.' '$PAGES'"
check "and the summary counts the two DRIFT lines" "[ \"\$(field config findings)\" = 2 ] && [ \"\$(field config rc)\" = 1 ]"
bash "$DR" > "$T/run2.log" 2>&1
check "the same two findings on the next run page NOTHING" "[ \"\$(wc -l < '$PAGES')\" -eq 1 ]"
check "and the journal says why, so the silence is a decision and not a loss" \
  "grep -q 'the same 2 finding(s) as last run, not paging again' '$T/run2.log'"
bash "$DR" > "$T/run3.log" 2>&1
check "nor the run after" "[ \"\$(wc -l < '$PAGES')\" -eq 1 ]"

echo "== drift-report: a CHANGED finding set pages again, even at the same count"
dr_env
audit_says "$T/bin/audit-drift" 1 "$DRIFT2"
bash "$DR" > /dev/null 2>&1
audit_says "$T/bin/audit-drift" 1 "$DRIFT2B"
bash "$DR" > "$T/run2.log" 2>&1
check "two pages: the count is 2 both times, the SET differs" \
  "[ \"\$(wc -l < '$PAGES')\" -eq 2 ] && grep -q '2 now, was 2' '$PAGES'"

echo "== drift-report: drift that CLEARS is said once, as cleared, and then silence"
dr_env
audit_says "$T/bin/audit-drift" 1 "$DRIFT2"
bash "$DR" > /dev/null 2>&1
audit_says "$T/bin/audit-drift" 0 "auditing box
no drift: this box matches the repo"
bash "$DR" > "$T/run2.log" 2>&1
check "the clear is paged with the previous count" "grep -q 'config drift CLEARED on .*: 0 findings, was 2' '$PAGES'"
check "and the summary reads zero findings, rc 0" "[ \"\$(field config findings)\" = 0 ] && [ \"\$(field config rc)\" = 0 ]"
bash "$DR" > /dev/null 2>&1
check "a second clean run pages nothing" "[ \"\$(wc -l < '$PAGES')\" -eq 2 ]"

echo "== drift-report: an INCOMPLETE audit is counted as unverified, paged once, not as clean"
dr_env
audit_says "$T/bin/audit-drift" 2 "$INCOMPLETE1"
bash "$DR" > "$T/run1.log" 2>&1
check "the summary carries rc 2 and one unverified item" "[ \"\$(field config rc)\" = 2 ] && [ \"\$(field config unverified)\" = 1 ] && [ \"\$(field config findings)\" = 0 ]"
check "and it paged as incomplete, with the count" "grep -q 'config audit INCOMPLETE on .*: 1 check(s) could not run, 0 finding(s)' '$PAGES'"
bash "$DR" > /dev/null 2>&1
check "and only once" "[ \"\$(wc -l < '$PAGES')\" -eq 1 ]"

echo "== drift-report: an UNDELIVERED change is not remembered, so it is tried again next run"
dr_env
audit_says "$T/bin/audit-drift" 1 "$DRIFT2"
STUB_ALERT_FAIL=1 bash "$DR" > "$T/run1.log" 2>&1
check "the run fails on purpose when a finding could not be delivered (unchanged behaviour)" "[ $? -eq 1 ]"
check "and nothing was remembered as delivered" "[ ! -f '$T/state/config.findings.sha' ]"
bash "$DR" > "$T/run2.log" 2>&1
check "the next run, with the webhook back, pages the same findings" "grep -q 'config findings CHANGED' '$PAGES'"
check "and the summary was written on the failed run too - the verdict does not depend on the page" \
  "grep -q 'summary written' '$T/run1.log'"

echo "== drift-report: an audit that cannot run publishes rc 3, which the reader classifies as incomplete"
dr_env
rm -f "$T/bin/audit-drift"
bash "$DR" > "$T/run1.log" 2>&1
check "config rc is 3 in the summary" "[ \"\$(field config rc)\" = 3 ]"
check "and the access audit still ran and reads 0" "[ \"\$(field access rc)\" = 0 ]"

echo "== drift-report: the access audit switched off is rc 0 with nothing counted, said in the journal"
dr_env
DRIFT_RUN_ACCESS=0 bash "$DR" > "$T/run1.log" 2>&1
check "access reads rc 0, findings 0" "[ \"\$(field access rc)\" = 0 ] && [ \"\$(field access findings)\" = 0 ]"

echo "== drift-report: a state dir that cannot be written loses the summary, and says so, and still pages"
dr_env
audit_says "$T/bin/audit-drift" 1 "$DRIFT2"
chmod 555 "$T/state"
bash "$DR" > "$T/run1.log" 2>&1
chmod 755 "$T/state"
check "the run warns that no summary was published" "grep -q 'no summary is published' '$T/run1.log'"
check "and the page still went out" "grep -q 'config findings CHANGED' '$PAGES'"
check "and no summary file exists to be read as a verdict" "[ ! -f '$T/state/summary.json' ]"

echo "== drift-report: the timer is every 30 minutes, not daily, and the bound the app applies is three misses"
check "the timer fires on a 30-minute interval" "grep -qE '^OnUnitActiveSec=30min' '$REPO/deploy/z3/faucet-drift-report.timer'"
check "and no longer at 03:40" "! grep -q 'OnCalendar' '$REPO/deploy/z3/faucet-drift-report.timer'"
check "and the app's staleness bound is 90 minutes, three missed runs" "grep -qE 'DRIFT_STALE_AFTER_MS = 90 \\* 60_000' '$REPO/src/lib/boxIntegrity.ts'"
