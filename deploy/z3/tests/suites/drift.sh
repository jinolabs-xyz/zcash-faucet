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
check "verbose shows the directive so the report is actionable" "grep -q 'MINER_MODE=submit' '$T/dropinv.log'"

echo "== drift: a stale installed script means the box runs unreviewed code"
drift_env; make_clean_box; echo "# hand edit on the box" >> "$T/install/thing.sh"
bash "$AUDIT" > "$T/stale.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "says the box runs unreviewed code" "grep -q 'unreviewed code' '$T/stale.log'"
drift_env; make_clean_box; rm -f "$T/install/thing.sh"
bash "$AUDIT" > "$T/noscript.log" 2>&1
check "a missing referenced script is drift" "[ $? -eq 1 ] && grep -q 'missing from' '$T/noscript.log'"

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
# Report-only is a design commitment, not an accident, so pin it: no branch
# that would act on --apply. The word appears in a comment explaining why it
# does not exist, hence matching the case branch rather than the word.
check "there is no --apply branch" "! grep -qE -- '[-][-]apply[)\"]' '$REPO/deploy/z3/audit-drift.sh'"
