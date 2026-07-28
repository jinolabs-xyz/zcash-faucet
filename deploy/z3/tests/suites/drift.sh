# shellcheck shell=bash
# audit-drift.sh: reports what is on a box but not in the repo, and vice
# versa. systemctl is stubbed; everything else is real files in a fake root.

AUDIT="$REPO/deploy/z3/audit-drift.sh"

drift_env() {
  T="$(mktemp -d "${TMPDIR:-/tmp}/drift-test.XXXXXX")"
  export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
  mkdir -p "$T/bin" "$T/units" "$T/install" "$T/env" "$T/repo/deploy/z3"
  ln -sf "$SCRATCH/stubs/audit-systemctl" "$T/bin/systemctl"
  export PATH="$T/bin:$BASE_PATH"
  export STUB_ENABLED="$T/enabled"; : > "$STUB_ENABLED"
  export AUDIT_REPO_DIR="$T/repo" AUDIT_OVERLAY_DIR="$T/repo/deploy/z3"
  export AUDIT_UNIT_DIR="$T/units" AUDIT_INSTALL_DIR="$T/install" AUDIT_ENV_DIR="$T/env"
  # A repo that ships one unit whose service runs one script.
  printf '[Service]\nExecStart=%s/thing.sh\n' "$T/install" > "$T/repo/deploy/z3/faucet-thing.service"
  printf '[Timer]\nOnCalendar=hourly\n' > "$T/repo/deploy/z3/faucet-thing.timer"
  printf '#!/usr/bin/env bash\necho thing\n' > "$T/repo/deploy/z3/thing.sh"
}
# A box that matches the repo exactly.
make_clean_box() {
  cp "$T/repo/deploy/z3/faucet-thing.service" "$T/repo/deploy/z3/faucet-thing.timer" "$T/units/"
  cp "$T/repo/deploy/z3/thing.sh" "$T/install/"
  printf 'faucet-thing.service\nfaucet-thing.timer\n' > "$STUB_ENABLED"
}

echo "== drift: a box matching the repo reports no drift and exits 0"
drift_env; make_clean_box
bash "$AUDIT" > "$T/clean.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "says no drift" "grep -q 'no drift' '$T/clean.log'"
check "prints no DRIFT lines" "! grep -q 'DRIFT' '$T/clean.log'"

echo "== drift: a missing unit is drift"
drift_env; make_clean_box; rm -f "$T/units/faucet-thing.timer"
bash "$AUDIT" > "$T/missing.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "names the missing unit" "grep -q 'faucet-thing.timer is not installed' '$T/missing.log'"

echo "== drift: an installed-but-disabled unit is drift (it dies at reboot)"
drift_env; make_clean_box; printf 'faucet-thing.service\n' > "$STUB_ENABLED"
bash "$AUDIT" > "$T/disabled.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "says it will not survive a reboot" "grep -q 'NOT enabled' '$T/disabled.log'"

echo "== drift: a unit whose content diverged is drift"
drift_env; make_clean_box; echo "# edited by hand" >> "$T/units/faucet-thing.service"
bash "$AUDIT" > "$T/edited.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "says it differs from the repo" "grep -q 'differs from the repo copy' '$T/edited.log'"

echo "== drift: a unit on the box with no repo copy is drift (a rebuild loses it)"
drift_env; make_clean_box
printf '[Service]\nExecStart=/bin/true\n' > "$T/units/faucet-handmade.service"
bash "$AUDIT" > "$T/extra.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "says a rebuild loses it" "grep -q 'faucet-handmade.service is installed but the repo has no copy' '$T/extra.log'"
# Units that are not ours must not be reported; the box runs plenty of others.
printf '[Service]\nExecStart=/bin/true\n' > "$T/units/ssh.service"
bash "$AUDIT" > "$T/extra2.log" 2>&1
check "unrelated units are ignored" "! grep -q 'ssh.service' '$T/extra2.log'"

echo "== drift: a hand-installed drop-in is reported (tonight's MINER_MODE case)"
drift_env; make_clean_box
mkdir -p "$T/units/zcash-testnet-miner.service.d"
printf '[Service]\nEnvironment=MINER_MODE=submit\n' > "$T/units/zcash-testnet-miner.service.d/override.conf"
bash "$AUDIT" > "$T/dropin.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "names the drop-in" "grep -q 'drop-in zcash-testnet-miner.service.d/override.conf' '$T/dropin.log'"
bash "$AUDIT" --verbose > "$T/dropinv.log" 2>&1
check "verbose shows the directive name, value redacted" "grep -q 'MINER_MODE=<redacted>' '$T/dropinv.log'"

echo "== drift: a stale installed script means the box runs unreviewed code"
drift_env; make_clean_box; echo "# hand edit on the box" >> "$T/install/thing.sh"
bash "$AUDIT" > "$T/stale.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "says the box runs unreviewed code" "grep -q 'unreviewed code' '$T/stale.log'"
drift_env; make_clean_box; rm -f "$T/install/thing.sh"
bash "$AUDIT" > "$T/noscript.log" 2>&1
check "a missing referenced script is drift" "[ $? -eq 1 ] && grep -q 'missing from' '$T/noscript.log'"

echo "== drift: an installed script must match even if no unit names it (SDE-CI)"
# The freshness check keyed off "does a .service reference this path", so any
# overlay script a unit runs INDIRECTLY was never compared. drift-report.sh
# invokes audit-access.sh and audit-drift.sh, so a hand-edited copy of the
# auditors themselves was invisible to the auditor. Verified by sabotage before
# the fix: this box reported "no drift" and exited 0.
drift_env; make_clean_box
printf '#!/usr/bin/env bash\necho helper\n' > "$T/repo/deploy/z3/helper.sh"
cp "$T/repo/deploy/z3/helper.sh" "$T/install/"
bash "$AUDIT" > "$T/unref-clean.log" 2>&1
check "an unreferenced script that matches is still clean" "[ $? -eq 0 ]"

echo "# hand edit on the box" >> "$T/install/helper.sh"
bash "$AUDIT" > "$T/unref-stale.log" 2>&1
check "a stale unreferenced script IS drift" "[ $? -eq 1 ]"
check "and says the box runs unreviewed code" \
  "grep -q 'helper.sh in .* differs from the repo' '$T/unref-stale.log'"

# The other half of the rule: never deployed is not drift, or every box would
# be permanently dirty for shipping scripts it does not install.
drift_env; make_clean_box
printf '#!/usr/bin/env bash\necho helper\n' > "$T/repo/deploy/z3/helper.sh"
bash "$AUDIT" > "$T/unref-absent.log" 2>&1
check "an unreferenced script that was never installed is NOT drift" "[ $? -eq 0 ]"
check "and is not mentioned as missing" "! grep -q 'helper.sh is referenced' '$T/unref-absent.log'"

echo "== drift: a script installed with NO repo copy is drift (the other direction)"
# The overlay loop walks the REPO, so it can only ask what the box did with each
# script we ship. A script existing only on the box is invisible to it, and that
# is the worse case: entirely unreviewed code that a rebuild silently drops.
# Units and drop-ins were already checked both ways.
drift_env; make_clean_box
printf '#!/usr/bin/env bash\necho hand-written\n' > "$T/install/operator-hack.sh"
bash "$AUDIT" > "$T/rev-extra.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "names the box-only script and says a rebuild loses it" \
  "grep -q 'operator-hack.sh is in .* but the repo has no copy of it, so a rebuild loses it' '$T/rev-extra.log'"
check "the fix commits it to the repo rather than deleting it" \
  "grep -A1 'operator-hack.sh is in' '$T/rev-extra.log' | grep -q 'git .* add deploy/z3/operator-hack.sh'"

# Symmetry must not become noise: a box holding exactly what the repo ships is
# still clean, and the script the unit runs is not reported twice.
drift_env; make_clean_box
bash "$AUDIT" --verbose > "$T/rev-clean.log" 2>&1
check "a matching box is still clean" "[ $? -eq 0 ]"
check "and thing.sh is not double-reported" \
  "[ \"\$(grep -c 'thing.sh' '$T/rev-clean.log')\" = '1' ]"

echo "== drift: env files report presence only, never values"
drift_env; make_clean_box
printf 'BACKUP_PASSPHRASE=hunter2-should-never-appear\n' > "$T/env/backup.env"
bash "$AUDIT" --verbose > "$T/env.log" 2>&1
check "reports the file as present" "grep -q 'backup.env present' '$T/env.log'"
check "NEVER prints the secret" "! grep -q 'hunter2' '$T/env.log'"
check "an absent env file is a note, not drift" "grep -q 'watchdog.env absent' '$T/env.log' && [ \"\$(grep -c 'DRIFT' '$T/env.log')\" = '0' ]"

echo "== drift: an audit that cannot run exits 2, never looks like a pass"
drift_env
AUDIT_REPO_DIR="$T/nope" AUDIT_OVERLAY_DIR="$T/nope/deploy/z3" bash "$AUDIT" > "$T/cannot.log" 2>&1
check "exits 2, not 0" "[ $? -eq 2 ]"
check "says it cannot audit" "grep -q 'cannot audit' '$T/cannot.log'"

echo "== drift: read-only, it changes nothing"
drift_env; make_clean_box
echo "# edited" >> "$T/units/faucet-thing.service"
# Both are read inside the eval'd check string below.
# shellcheck disable=SC2034
before="$(find "$T/units" "$T/install" "$T/env" -type f -exec sha256sum {} \; | sort)"
bash "$AUDIT" > /dev/null 2>&1
# shellcheck disable=SC2034
after="$(find "$T/units" "$T/install" "$T/env" -type f -exec sha256sum {} \; | sort)"
check "no file on the box was touched" "[ \"\$before\" = \"\$after\" ]"
# Report-only is a commitment, so pin it. Matches the case branch, not the
# word, which appears in the header explaining why the flag does not exist.
check "there is no --apply branch" "! grep -qE -- '[-][-]apply[)\"]' '$REPO/deploy/z3/audit-drift.sh'"

echo "== drift: every finding carries a paste-able fix command"
drift_env; make_clean_box; rm -f "$T/units/faucet-thing.timer"
bash "$AUDIT" > "$T/fix1.log" 2>&1
check "missing unit prints an install command" "grep -A1 'faucet-thing.timer is not installed' '$T/fix1.log' | grep -q 'fix: cp .* && systemctl daemon-reload && systemctl enable --now faucet-thing.timer'"

drift_env; make_clean_box; printf 'faucet-thing.service\n' > "$STUB_ENABLED"
bash "$AUDIT" > "$T/fix2.log" 2>&1
check "disabled unit prints the enable command" "grep -A1 'NOT enabled' '$T/fix2.log' | grep -q 'fix: systemctl enable --now faucet-thing.timer'"

drift_env; make_clean_box
printf '[Service]\nExecStart=/bin/true\n' > "$T/units/faucet-handmade.service"
bash "$AUDIT" > "$T/fix3.log" 2>&1
check "unit missing from the repo prints a git add" "grep -A1 'faucet-handmade.service is installed but the repo' '$T/fix3.log' | grep -q 'fix: cp .* git .* add deploy/z3/faucet-handmade.service'"

drift_env; make_clean_box; echo "# hand edit" >> "$T/install/thing.sh"
bash "$AUDIT" > "$T/fix4.log" 2>&1
check "stale script prints a diff command" "grep -A1 'unreviewed code' '$T/fix4.log' | grep -q 'fix: diff '"

# The fix line must never appear on a clean run, or the report teaches people
# to ignore it.
drift_env; make_clean_box
bash "$AUDIT" --verbose > "$T/fix5.log" 2>&1
check "no fix lines when there is no drift" "! grep -q 'fix:' '$T/fix5.log'"

echo "== drift: a skipped check is never reported as clean (doctrine rule 1)"
# Before the fix this printed "matches the repo" and exited 0 without ever
# checking whether a unit would survive a reboot.
drift_env; make_clean_box
AUDIT_SYSTEMCTL="$T/no-such-systemctl" bash "$AUDIT" > "$T/unver.log" 2>&1
rc_unver=$?
check "exits 2, not 0, when a check could not run" "[ $rc_unver -eq 2 ]"
check "prints a NOT VERIFIED section" "grep -q 'NOT VERIFIED' '$T/unver.log'"
check "names what was skipped" "grep -q 'whether any unit is ENABLED' '$T/unver.log'"
check "never claims the box matches the repo" "! grep -q 'no drift: this box matches the repo' '$T/unver.log'"
check "says the audit was incomplete" "grep -q 'INCOMPLETE' '$T/unver.log'"

# Real drift still reports as drift (1) even when something was unverified,
# because a confirmed finding is more actionable than an incomplete audit.
drift_env; make_clean_box; rm -f "$T/units/faucet-thing.timer"
AUDIT_SYSTEMCTL="$T/no-such-systemctl" bash "$AUDIT" > "$T/unver2.log" 2>&1
check "confirmed drift still exits 1" "[ $? -eq 1 ]"
check "and still lists what was not verified" "grep -q 'NOT VERIFIED' '$T/unver2.log'"

echo "== drift: the audited set comes from the repo, not a name prefix"
# A unit named outside faucet-*/zsnap-*/zcash-* must still be audited if the
# repo ships it. The old prefix filter would have gone silently blind here.
drift_env
printf '[Service]\nExecStart=/bin/true\n' > "$T/repo/deploy/z3/mining-pool.service"
bash "$AUDIT" > "$T/derived.log" 2>&1
check "an oddly named repo unit is still audited" "[ $? -eq 1 ] && grep -q 'mining-pool.service is not installed' '$T/derived.log'"

# And its hand-added drop-in is caught too, which the prefix list would miss.
drift_env; make_clean_box
printf '[Service]\nExecStart=/bin/true\n' > "$T/repo/deploy/z3/mining-pool.service"
cp "$T/repo/deploy/z3/mining-pool.service" "$T/units/"
printf 'faucet-thing.service\nfaucet-thing.timer\nmining-pool.service\n' > "$STUB_ENABLED"
mkdir -p "$T/units/mining-pool.service.d"
printf '[Service]\nEnvironment=POOL=x\n' > "$T/units/mining-pool.service.d/override.conf"
bash "$AUDIT" > "$T/derived2.log" 2>&1
check "its drop-in is reported" "grep -q 'drop-in mining-pool.service.d/override.conf' '$T/derived2.log'"

# Units the repo does not ship at all stay out of the report.
drift_env; make_clean_box
printf '[Service]\nExecStart=/bin/true\n' > "$T/units/nginx.service"
mkdir -p "$T/units/nginx.service.d"; printf '[Service]\n' > "$T/units/nginx.service.d/o.conf"
bash "$AUDIT" > "$T/derived3.log" 2>&1
check "unrelated units and their drop-ins stay out" "! grep -q 'nginx' '$T/derived3.log'"

echo "== drift: drop-in values are redacted, names are kept"
# QA's objection: a drop-in can carry a webhook URL or an RPC password, and a
# drift report gets pasted into issues.
drift_env; make_clean_box
mkdir -p "$T/units/faucet-thing.service.d"
printf '[Service]\nEnvironment=WATCHDOG_ALERT_URL=https://hooks.slack.com/services/SUPERSECRET\nEnvironment=MINER_MODE=submit\n' \
  > "$T/units/faucet-thing.service.d/override.conf"
bash "$AUDIT" --verbose > "$T/redact.log" 2>&1
check "the secret NEVER appears" "! grep -q 'SUPERSECRET' '$T/redact.log'"
check "nor does any hooks.slack.com URL" "! grep -q 'hooks.slack.com' '$T/redact.log'"
check "the directive name is still shown" "grep -q 'WATCHDOG_ALERT_URL=<redacted>' '$T/redact.log'"
check "so is the second one, still actionable" "grep -q 'MINER_MODE=<redacted>' '$T/redact.log'"
check "the drop-in is still reported as drift" "grep -q 'drop-in faucet-thing.service.d/override.conf' '$T/redact.log'"

echo "== drift: nothing unmatched prints, so continuations and comments cannot leak"
# SDE-App's finding: both old rules needed an = on the line, so a systemd
# continuation carrying --rpc-password, and a comment carrying a webhook,
# printed verbatim. The printer is an allowlist now.
drift_env; make_clean_box
mkdir -p "$T/units/faucet-thing.service.d"
printf '[Service]\nEnvironment=MINER_MODE=submit\nExecStart=/opt/faucet/miner \\\n    --rpc-password HUNTER2_ACTUAL_SECRET \\\n    --address tmXXXX\n# note: webhook https://hooks.slack.com/services/T0/B0/COMMENTSECRET\n' \
  > "$T/units/faucet-thing.service.d/override.conf"
bash "$AUDIT" --verbose > "$T/leak.log" 2>&1
check "the continuation-line password never prints" "! grep -q 'HUNTER2_ACTUAL_SECRET' '$T/leak.log'"
check "the comment webhook never prints" "! grep -q 'COMMENTSECRET' '$T/leak.log'"
check "no hooks.slack.com anywhere" "! grep -q 'hooks.slack.com' '$T/leak.log'"
check "the [Service] header does not print either" "! grep -q '| \[Service\]' '$T/leak.log'"
check "Environment keeps its variable name" "grep -q 'Environment=MINER_MODE=<redacted>' '$T/leak.log'"
check "ExecStart is named but its arguments are gone" "grep -q 'ExecStart=<redacted>' '$T/leak.log'"
check "the drop-in is still reported as drift" "grep -q 'drop-in faucet-thing.service.d/override.conf' '$T/leak.log'"

echo "== drift-report: the alert names WHICH outcome, not just that a unit failed"
REPORT="$REPO/deploy/z3/drift-report.sh"
report_env() {
  T="$(mktemp -d "${TMPDIR:-/tmp}/report-test.XXXXXX")"
  mkdir -p "$T/bin"
  printf '#!/usr/bin/env bash\necho "ALERT: $*" >> %q\n' "$T/alerts.log" > "$T/alert.sh"
  chmod +x "$T/alert.sh"
  : > "$T/alerts.log"
  export DRIFT_ALERT_SH="$T/alert.sh" DRIFT_RUN_ACCESS=0
}
fake_audit() { # $1 exit code
  printf '#!/usr/bin/env bash\necho "  FINDING  something"\nexit %s\n' "$1" > "$T/audit.sh"
  chmod +x "$T/audit.sh"; export DRIFT_AUDIT="$T/audit.sh"
}

report_env; fake_audit 0
bash "$REPORT" > "$T/clean.log" 2>&1
check "a clean audit exits 0" "[ $? -eq 0 ]"
check "and pages nobody" "[ ! -s '$T/alerts.log' ]"
check "and says clean in the journal" "grep -q 'config: clean' '$T/clean.log'"

report_env; fake_audit 1
bash "$REPORT" > "$T/drift.log" 2>&1
check "drift found still exits 0, it reported successfully" "[ $? -eq 0 ]"
check "the alert says there are findings" "grep -q 'config findings' '$T/alerts.log'"
check "the alert explains why it matters" "grep -q 'a rebuild would not reproduce this box' '$T/alerts.log'"
check "the alert says where to look" "grep -q 'journalctl -u faucet-drift-report' '$T/alerts.log'"
check "the audit output is in the journal" "grep -q 'FINDING' '$T/drift.log'"

report_env; fake_audit 2
bash "$REPORT" > "$T/incomplete.log" 2>&1
check "incomplete exits 0" "[ $? -eq 0 ]"
check "the alert says INCOMPLETE, not findings" "grep -q 'INCOMPLETE' '$T/alerts.log' && ! grep -q 'config findings' '$T/alerts.log'"
check "and warns a problem may exist unseen" "grep -q 'may exist unseen' '$T/alerts.log'"

report_env
export DRIFT_AUDIT="$T/not-installed.sh"
bash "$REPORT" > "$T/missing.log" 2>&1
check "a missing audit exits NONZERO so OnFailure catches it" "[ $? -ne 0 ]"
check "and says which script is missing" "grep -q 'audit missing or not executable' '$T/missing.log'"

echo "== drift-report: a finding nobody could be told about is a FAILED unit"
# The unit exists so that someone HEARS about drift. Discarding alert.sh's rc
# left the worst state silent: drift found, journald has it, nobody paged, unit
# green, operator sees a healthy timer. Audit-blind means we do not know.
# Alert-failed means we DO know and the person who needs to does not.
# The three codes below are alert.sh's own contract, pinned against the real
# script in the alerts suite. Here we test what this wrapper does with each.
alert_exiting() { # $1 exit code
  printf '#!/usr/bin/env bash\nexit %s\n' "$1" > "$T/alert.sh"; chmod +x "$T/alert.sh"
}

report_env; fake_audit 1; alert_exiting 3
bash "$REPORT" > "$T/undeliv-unconfigured.log" 2>&1; rc=$?
check "drift found with no webhook configured FAILS the unit" "[ $rc -ne 0 ]"
check "and names the fix, not just a failure" "grep -q 'no FAUCET_ALERT_URL configured' '$T/undeliv-unconfigured.log'"
check "and says the unit is failing on purpose" "grep -q 'could NOT be delivered' '$T/undeliv-unconfigured.log'"
check "and says systemctl is the remaining signal" "grep -q 'systemctl is the only signal left' '$T/undeliv-unconfigured.log'"

report_env; fake_audit 1; alert_exiting 4
bash "$REPORT" > "$T/undeliv-encoder.log" 2>&1; rc=$?
check "a missing encoder fails the unit too" "[ $rc -ne 0 ]"
check "and blames the encoder, not the webhook URL" \
  "grep -q 'no jq and no python3' '$T/undeliv-encoder.log' && ! grep -q 'rejected the POST' '$T/undeliv-encoder.log'"

report_env; fake_audit 1; alert_exiting 1
bash "$REPORT" > "$T/undeliv-post.log" 2>&1; rc=$?
check "a rejected POST fails the unit" "[ $rc -ne 0 ]"
check "and blames the webhook, not the config" \
  "grep -q 'webhook rejected the POST' '$T/undeliv-post.log' && ! grep -q 'no FAUCET_ALERT_URL' '$T/undeliv-post.log'"

report_env; fake_audit 1
export DRIFT_ALERT_SH="$T/no-such-alert.sh"
bash "$REPORT" > "$T/undeliv-missing.log" 2>&1; rc=$?
check "an alert script that is not there fails the unit" "[ $rc -ne 0 ]"
check "and says no runnable alert script" "grep -q 'no runnable alert script' '$T/undeliv-missing.log'"

# A broken alerter is only a problem when there was something to send. A clean
# box must not page or fail just because nobody configured a webhook.
report_env; fake_audit 0; alert_exiting 3
bash "$REPORT" > "$T/clean-broken-alert.log" 2>&1; rc=$?
check "a clean audit with a broken alerter stays GREEN" "[ $rc -eq 0 ]"

# Everything above stubs alert.sh, so a wrong default path would leave all of
# it passing while the real unit alerts nothing. This one runs the shipped
# alert.sh for real: unconfigured, it must exit 3 and fail the unit.
report_env; fake_audit 1
unset DRIFT_ALERT_SH
env -u FAUCET_ALERT_URL -u WATCHDOG_ALERT_URL bash "$REPORT" > "$T/real-alert.log" 2>&1; rc=$?
check "the DEFAULT alert path is the shipped alert.sh, reached without env help" "[ $rc -ne 0 ]"
check "and the real script reports itself unconfigured" "grep -q 'no FAUCET_ALERT_URL configured' '$T/real-alert.log'"

echo "== drift-report: each audit explains its OWN finding (SDE-CI's copy finding)"
# One shared sentence misdescribes whichever audit did not write it. An access
# finding is not the box disagreeing with the repo, it is something reachable
# that should not be, and a wrong explanation at 3am costs more than none.
report_env; fake_audit 0
export DRIFT_RUN_ACCESS=1
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/access.sh"; chmod +x "$T/access.sh"
export DRIFT_ACCESS_AUDIT="$T/access.sh"
bash "$REPORT" > "$T/wording.log" 2>&1
check "the access alert does NOT claim the repo disagrees" \
  "! grep -q 'repo disagree' '$T/alerts.log'"
check "it says something is reachable that should not be" \
  "grep -q 'reachable that should not be' '$T/alerts.log'"
check "and points at the binding, since ufw cannot close a docker port" \
  "grep -q 'BINDING' '$T/alerts.log'"

report_env; fake_audit 1
export DRIFT_RUN_ACCESS=0
bash "$REPORT" > "$T/wording2.log" 2>&1
check "the config alert keeps its own explanation" \
  "grep -q 'repo disagree' '$T/alerts.log'"
check "and does not borrow the access wording" \
  "! grep -q 'reachable that should not be' '$T/alerts.log'"

echo "== drift-report: the worse of the two audits decides the outcome"
report_env; fake_audit 0
export DRIFT_RUN_ACCESS=1
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/access.sh"; chmod +x "$T/access.sh"
export DRIFT_ACCESS_AUDIT="$T/access.sh"
bash "$REPORT" > "$T/both.log" 2>&1
check "a clean config plus access drift still alerts" "grep -q 'access findings' '$T/alerts.log'"
check "and the clean one is reported clean" "grep -q 'config: clean' '$T/both.log'"
