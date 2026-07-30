# shellcheck shell=bash
# audit-drift.sh: reports what is on a box but not in the repo, and vice
# versa. systemctl is stubbed; everything else is real files in a fake root.

AUDIT="$REPO/deploy/z3/audit-drift.sh"

drift_env() {
  mk_scratch "${TMPDIR:-/tmp}/drift-test.XXXXXX"
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
  # The env-completeness half needs src/ and a declaring env file, or the fixture
  # does not model its inputs at all. It did not, so every clean-box case hit the
  # "no src, cannot list what the app reads" path, which is correctly an UNVERIFIED
  # and correctly exits 2 — and that broke four exit-0 baselines. The check was
  # right and the fixture was incomplete, so the fixture is what changes here.
  mkdir -p "$T/repo/src/lib"
  printf 'const a = process.env.FIXTURE_DECLARED_KEY;\nconst b = num("FIXTURE_TUNING_KEY", 5);\n' \
    > "$T/repo/src/lib/config.ts"
  printf 'FIXTURE_DECLARED_KEY=yes\nFIXTURE_TUNING_KEY=5\n' \
    > "$T/repo/deploy/z3/faucet.env.example"
  # The stack-versions half needs a pin file AND a docker to ask, or every case
  # below hits its cannot-check path, correctly exits 2, and breaks six clean-box
  # baselines. Same shape as the env-completeness fixture above: the check was
  # right and the fixture modelled none of its inputs. Nothing pinned and nothing
  # running is the deliberately quiet case, so the baseline stays clean.
  printf '#Z3_ZEBRA_IMAGE=\n' > "$T/repo/deploy/z3/stack-versions.env"
  export AUDIT_VERSIONS_FILE="$T/repo/deploy/z3/stack-versions.env"
  export AUDIT_DOCKER="$T/bin/docker-stub"
  # Stub docker: `ps --filter name=X` prints $STUB_RUNNING_X, `inspect` prints
  # $STUB_IMAGE_<sanitised container name>. Empty means absent, which is how the
  # not-running and cannot-inspect cases are expressed. Injected via AUDIT_DOCKER
  # rather than PATH for the same reason systemctl is: a runner that HAS docker
  # would otherwise reach the real one and the result would depend on the machine.
  cat > "$T/bin/docker-stub" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  ps)
    for a in "$@"; do case "$a" in name=*) m="${a#name=}";; esac; done
    v="STUB_RUNNING_$m"
    # Two ps shapes now: bare names for the version check, and name plus compose
    # project for the orphan check. Separate cases, because one answer serving both
    # questions is a stub that agrees with whatever it is asked.
    case " $* " in
      *compose.project*)
        # Default to a project rather than to empty. Empty means "started by hand",
        # which is the FINDING, and a stub whose default is the finding would make
        # every unrelated fixture report an orphan it never created.
        for c in ${!v:-}; do
          pv="STUB_PROJECT_$(printf '%s' "$c" | tr -c 'A-Za-z0-9' '_')"
          if [ -n "${!pv+set}" ]; then printf '%s %s\n' "$c" "${!pv}"; else printf '%s z3\n' "$c"; fi
        done ;;
      *) printf '%s\n' "${!v:-}" | grep -v '^$' || true ;;
    esac ;;
  inspect)
    # TWO questions arrive here now, and they must not share a case: what reference a
    # CONTAINER was created from, and what registry digests an IMAGE has. Answering
    # both from one variable is how a stub starts agreeing with whatever it is asked.
    n="${!#}"; k="$(printf '%s' "$n" | tr -c 'A-Za-z0-9' '_')"
    case " $* " in
      *RepoDigests*) v="STUB_REPODIGESTS_$k" ;;
      *)             v="STUB_IMAGE_$k" ;;
    esac
    printf '%s\n' "${!v:-}" | grep -v '^$' || true ;;
esac
STUB
  chmod +x "$T/bin/docker-stub"
  # Leaked exports from a previous case would make a later one see a container
  # that this fixture never started, which is how my own not-running test first
  # failed for a reason that had nothing to do with the code under test.
  unset "${!STUB_RUNNING_@}" "${!STUB_IMAGE_@}" "${!STUB_REPODIGESTS_@}" "${!STUB_PROJECT_@}" 2>/dev/null || true
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
# Exit 2 is "could not check", exit 1 is "checked and found drift". The clean box
# must be COMPLETE as well as clean, or an audit that silently skipped half its
# job reads the same as one that passed it.
check "and the audit was complete, not merely quiet" "! grep -q 'NOT VERIFIED' '$T/clean.log'"

echo "== drift: the env-completeness half actually FIRES"
# The clean case above proves the check is SILENT on a good box, which is only half
# a proof — a check that never speaks at all passes it too. This is the positive
# control, and exit 1 rather than nonzero because exit 2 would mean it could not
# look rather than that it looked and found something.
drift_env; make_clean_box
printf 'const c = process.env.FIXTURE_UNDECLARED_KEY;\n' >> "$T/repo/src/lib/config.ts"
bash "$AUDIT" > "$T/env-undeclared.log" 2>&1
check "an undeclared key the app reads is reported as DRIFT" "[ $? -eq 1 ]"
check "and the key is named, so the operator knows which one" \
  "grep -q 'FIXTURE_UNDECLARED_KEY' '$T/env-undeclared.log'"

echo "== drift: a key read only by a TEST is not deployment config"
# process.env.PATH in a test harness was reported undeclared on every box forever,
# and a check that always reports drift is one people learn to ignore.
drift_env; make_clean_box
printf 'const p = process.env.FIXTURE_TEST_ONLY_KEY;\n' > "$T/repo/src/lib/spawn.test.ts"
bash "$AUDIT" > "$T/env-testonly.log" 2>&1
check "a test-only env read is not drift" "[ $? -eq 0 ]"
check "and it is not named as undeclared" \
  "! grep -q 'FIXTURE_TEST_ONLY_KEY' '$T/env-testonly.log'"

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

# Guard the guard, in two directions, because this assertion is the only
# evidence for the read-only promise OPERATIONS.md makes in bold.
#
# With no sha256sum on the host, both listings come back EMPTY, compare equal,
# and the check below reports ok having verified nothing. #164's preflight now
# refuses such a host, but a test pinning a claim we state loudly should not
# depend on a gate in another file to stay honest.
check "the listing actually hashed something, empty would equal empty" \
  "printf '%s' \"\$before\" | grep -qE '^[0-9a-f]{64} '"

check "no file on the box was touched" "[ \"\$before\" = \"\$after\" ]"

# Positive control: prove the comparison can FAIL. Equality is only evidence if
# inequality is reachable, and a listing that never changes would pass this test
# no matter what the audit did to the box.
# shellcheck disable=SC2034
echo "# a change the comparison must notice" >> "$T/units/faucet-thing.service"
# shellcheck disable=SC2034
perturbed="$(find "$T/units" "$T/install" "$T/env" -type f -exec sha256sum {} \; | sort)"
check "and the comparison detects a real change, so equality means something" \
  "[ \"\$before\" != \"\$perturbed\" ]"
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
  mk_scratch "${TMPDIR:-/tmp}/report-test.XXXXXX"
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

# --- node stack versions (#247) -----------------------------------------------
# docker is injected via AUDIT_DOCKER rather than PATH, for the same reason
# systemctl is: a runner that HAS docker would otherwise reach the real one and
# the result would depend on the machine.
versions_env() {
  drift_env; make_clean_box
}

echo "== versions: a box running the pinned image reports no drift"
versions_env
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.2.0\n' > "$AUDIT_VERSIONS_FILE"
export STUB_RUNNING_zebra=z3-zebra-1
export STUB_IMAGE_z3_zebra_1="zfnd/zebra:6.2.0"
bash "$AUDIT" > "$T/v-match.log" 2>&1; rc=$?
check "exits 0" "[ $rc -eq 0 ]"
check "reports no drift" "grep -q 'no drift' '$T/v-match.log'"
check "and did not silently skip the version check" "! grep -q 'stack versions:' '$T/v-match.log'"

# We pin the wallet BY DIGEST, because z3's compose defaults it to a digest and writing
# the tag alone would swap an immutable reference for a moveable one. The box was created
# from the plain tag, so .Config.Image is the tag and a text compare reports drift on
# every single run. A line that is always red is a line people stop reading, so the
# comparison has to be about the image rather than about the string.
echo "== versions: a digest pin matches a container created from the equivalent tag"
versions_env
printf 'Z3_ZALLET_IMAGE=zodlinc/zallet:v0.1.0-beta.1@%s\n' "sha256:1849b4469875dc0165942c06d15fa6a7da76b2d43bade578cc8e5903a639869d" > "$AUDIT_VERSIONS_FILE"
export STUB_RUNNING_zallet=z3-zallet-1
export STUB_IMAGE_z3_zallet_1="zodlinc/zallet:v0.1.0-beta.1"
export STUB_REPODIGESTS_zodlinc_zallet_v0_1_0_beta_1="zodlinc/zallet@sha256:1849b4469875dc0165942c06d15fa6a7da76b2d43bade578cc8e5903a639869d"
# --verbose because ok() is quiet without it, which is right for a cron audit and means
# a test that wants to read the POSITIVE message has to ask for it.
bash "$AUDIT" --verbose > "$T/v-digest.log" 2>&1; rc=$?
check "a digest pin against the same image by tag exits 0" "[ $rc -eq 0 ]"
check "and reports no drift" "grep -q 'no drift' '$T/v-digest.log'"
check "and says it matched by DIGEST, not by luck" "grep -q 'matches by digest' '$T/v-digest.log'"

echo "== versions: a MOVED tag is caught even though the text never changed"
# The failure the digest exists to catch. .Config.Image is byte-identical to the case
# above; only what the registry served changed. A text compare cannot see this at all.
versions_env
printf 'Z3_ZALLET_IMAGE=zodlinc/zallet:v0.1.0-beta.1@%s\n' "sha256:1849b4469875dc0165942c06d15fa6a7da76b2d43bade578cc8e5903a639869d" > "$AUDIT_VERSIONS_FILE"
export STUB_RUNNING_zallet=z3-zallet-1
export STUB_IMAGE_z3_zallet_1="zodlinc/zallet:v0.1.0-beta.1"
export STUB_REPODIGESTS_zodlinc_zallet_v0_1_0_beta_1="zodlinc/zallet@sha256:0000000000000000000000000000000000000000000000000000000000000000"
bash "$AUDIT" > "$T/v-moved.log" 2>&1; rc=$?
check "a tag that no longer resolves to the pinned digest is DRIFT" "[ $rc -eq 1 ]"
check "and names the digest rather than saying the images differ" "grep -q 'whose digest is not' '$T/v-moved.log'"

echo "== versions: an image with no registry digest is NOT VERIFIED, not a pass"
# A locally built image has no RepoDigests. We did not learn that it differs, so this
# must not read as agreement, and it must not read as drift either.
versions_env
printf 'Z3_ZALLET_IMAGE=zodlinc/zallet:v0.1.0-beta.1@%s\n' "sha256:1849b4469875dc0165942c06d15fa6a7da76b2d43bade578cc8e5903a639869d" > "$AUDIT_VERSIONS_FILE"
export STUB_RUNNING_zallet=z3-zallet-1
export STUB_IMAGE_z3_zallet_1="zodlinc/zallet:v0.1.0-beta.1"
bash "$AUDIT" > "$T/v-nodigest.log" 2>&1; rc=$?
check "an unresolvable digest exits 2, the incomplete code" "[ $rc -eq 2 ]"
check "and says so under NOT VERIFIED" "grep -q 'no registry digest' '$T/v-nodigest.log'"
check "and does NOT claim a match" "! grep -q 'matches by digest' '$T/v-nodigest.log'"
check "and does NOT claim drift" "! grep -q 'DRIFT FOUND' '$T/v-nodigest.log'"

echo "== versions: two digest references for the same image agree"
versions_env
printf 'Z3_ZALLET_IMAGE=zodlinc/zallet:v0.1.0-beta.1@%s\n' "sha256:1849b4469875dc0165942c06d15fa6a7da76b2d43bade578cc8e5903a639869d" > "$AUDIT_VERSIONS_FILE"
export STUB_RUNNING_zallet=z3-zallet-1
export STUB_IMAGE_z3_zallet_1="zodlinc/zallet@sha256:1849b4469875dc0165942c06d15fa6a7da76b2d43bade578cc8e5903a639869d"
bash "$AUDIT" --verbose > "$T/v-bothdg.log" 2>&1; rc=$?
check "the same digest written two ways is not drift" "[ $rc -eq 0 ]"
check "and is reported as a digest match" "grep -q 'matches by digest' '$T/v-bothdg.log'"

# ORPHANS. Every version check above reads the FIRST container whose name matches, so it
# cannot see a second one, and a container outside the compose project is invisible to the
# tooling that manages the stack: no recreate, no stop, and a pin bump cannot reach it.
echo "== orphans: a container matching our images but in NO compose project is drift"
versions_env
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.2.0\n' > "$AUDIT_VERSIONS_FILE"
export STUB_RUNNING_zebra="z3-zebra-1 stray-zebra"
export STUB_IMAGE_z3_zebra_1="zfnd/zebra:6.2.0"
export STUB_PROJECT_stray_zebra=""
bash "$AUDIT" > "$T/orphan.log" 2>&1; rc=$?
check "a hand-started container matching the stack is DRIFT" "[ $rc -eq 1 ]"
check "and it is named" "grep -q 'stray-zebra' '$T/orphan.log'"
check "and the reason is the compose project, not the image" \
  "grep -q 'belongs to no compose project' '$T/orphan.log'"
check "and it says compose cannot manage it, which is WHY this matters" \
  "grep -q 'compose cannot recreate or stop it' '$T/orphan.log'"
# The version line above looked at z3-zebra-1 and reported a match. That is exactly the
# false reassurance this check exists to break.
check "and the count is reported too, since the version line described only one of them" \
  "grep -q 'containers match' '$T/orphan.log'"

echo "== orphans: two containers in the SAME project is still reported"
# Not an orphan, but the version check still silently picked one of two.
versions_env
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.2.0\n' > "$AUDIT_VERSIONS_FILE"
export STUB_RUNNING_zebra="z3-zebra-1 z3-zebra-2"
export STUB_IMAGE_z3_zebra_1="zfnd/zebra:6.2.0"
bash "$AUDIT" > "$T/twin.log" 2>&1; rc=$?
check "two containers for one component is drift" "[ $rc -eq 1 ]"
check "and says the version above described only one of them" \
  "grep -q 'describes only one of them' '$T/twin.log'"
check "but does NOT call either one an orphan, because both are in the project" \
  "! grep -q 'belongs to no compose project' '$T/twin.log'"

echo "== orphans: a normal single container in a project is silent"
# The check has to be quiet in the ordinary case or nobody will keep it.
versions_env
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.2.0\n' > "$AUDIT_VERSIONS_FILE"
export STUB_RUNNING_zebra=z3-zebra-1
export STUB_IMAGE_z3_zebra_1="zfnd/zebra:6.2.0"
bash "$AUDIT" > "$T/noorphan.log" 2>&1; rc=$?
check "one container, in a project, matching the pin, exits 0" "[ $rc -eq 0 ]"
check "and says nothing about orphans" "! grep -q 'compose project' '$T/noorphan.log'"

echo "== versions: a box running a DIFFERENT image than the pin is drift"
# The whole point of #247. Without this the version could change under us and
# every signal we have would stay green.
versions_env
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.2.0\n' > "$AUDIT_VERSIONS_FILE"
export STUB_RUNNING_zebra=z3-zebra-1
export STUB_IMAGE_z3_zebra_1="zfnd/zebra:6.2.3"
bash "$AUDIT" > "$T/v-drift.log" 2>&1; rc=$?
check "exits 1" "[ $rc -eq 1 ]"
check "names BOTH the running and the pinned version" \
  "grep -q 'runs zfnd/zebra:6.2.3' '$T/v-drift.log' && grep -q 'pins zfnd/zebra:6.2.0' '$T/v-drift.log'"

echo "== versions: an unpinned component that IS running is unverified, not clean"
# A running container nobody pinned is the exact hole #247 describes, so it must
# not read the same as a match.
versions_env
printf '#Z3_ZALLET_IMAGE=\n' > "$AUDIT_VERSIONS_FILE"
export STUB_RUNNING_zallet=z3-zallet-1
export STUB_IMAGE_z3_zallet_1="zodlinc/zallet:whatever"
bash "$AUDIT" > "$T/v-unpinned.log" 2>&1; rc=$?
check "exits 2, not 0" "[ $rc -eq 2 ]"
check "says NOT VERIFIED" "grep -q 'NOT VERIFIED' '$T/v-unpinned.log'"
check "and names the unpinned component" "grep -q 'not pinned' '$T/v-unpinned.log'"

echo "== versions: an unpinned component that is NOT running stays quiet"
# Otherwise the optional zaino reports forever and the whole audit gets ignored.
versions_env
printf '#Z3_ZAINO_IMAGE=\n' > "$AUDIT_VERSIONS_FILE"
bash "$AUDIT" > "$T/v-absent.log" 2>&1; rc=$?
check "exits 0" "[ $rc -eq 0 ]"
check "says nothing about zaino" "! grep -q 'ZAINO' '$T/v-absent.log'"

echo "== versions: no pin file at all is unverified, not a pass"
versions_env
rm -f "$AUDIT_VERSIONS_FILE"
bash "$AUDIT" > "$T/v-nofile.log" 2>&1; rc=$?
check "exits 2" "[ $rc -eq 2 ]"
check "says nothing records the intended versions" \
  "grep -q 'nothing records which node and wallet images' '$T/v-nofile.log'"

echo "== versions: docker missing is unverified, not a pass"
# The box that cannot be inspected is not the box that matches.
versions_env
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.2.0\n' > "$AUDIT_VERSIONS_FILE"
export AUDIT_DOCKER="$T/bin/no-such-docker"
bash "$AUDIT" > "$T/v-nodocker.log" 2>&1; rc=$?
check "exits 2" "[ $rc -eq 2 ]"
check "says the images were not compared" "grep -q 'were not compared' '$T/v-nodocker.log'"
