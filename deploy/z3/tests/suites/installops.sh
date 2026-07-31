# shellcheck shell=bash
# install-ops.sh: the script that puts our ops code on the box.
#
# IT HAD NO SUITE AT ALL, and that is why it shipped broken for weeks. It took its
# source directory from its own location, and auto-deploy.sh installs it to /opt/faucet
# and runs the INSTALLED copy — so on the box the source WAS the destination. It globbed
# the destination, copied files onto themselves, could not see anything that was missing,
# and reported "0 installed, N already current" with exit 0. 19 of 25 required files were
# never installed, audit-drift.sh among them: the auditor that would have said so.
#
# The reason nobody noticed is worth keeping in mind while reading these cases. Running it
# by hand from a checkout is the ONE situation where source and destination differ, so it
# worked every single time a human tried it.

INSTALL_OPS="$REPO/deploy/z3/install-ops.sh"

ops_env() {
  mk_scratch "${TMPDIR:-/tmp}/installops-test.XXXXXX"
  export PATH="$SCRATCH/stubs:$BASE_PATH"
  mkdir -p "$T/src" "$T/install" "$T/units"
  export OPS_INSTALL_DIR="$T/install" OPS_UNIT_DIR="$T/units"
  # The stub refuses to enable a unit whose file is absent, the way systemd would.
  export STUB_UNIT_DIR="$T/units"
  export OPS_SYSTEMCTL="$SCRATCH/stubs/audit-systemctl"
  export STUB_ENABLED="$T/enabled"; : > "$STUB_ENABLED"
  # A source that looks like deploy/z3: several scripts, a unit, a timer.
  printf '#!/usr/bin/env bash\necho watchdog\n'   > "$T/src/watchdog.sh"
  printf '#!/usr/bin/env bash\necho audit\n'      > "$T/src/audit-drift.sh"
  printf '#!/usr/bin/env bash\necho alert\n'      > "$T/src/alert.sh"
  printf '[Service]\nExecStart=/bin/true\n'       > "$T/src/faucet-thing.service"
  printf '[Timer]\nOnCalendar=hourly\n'           > "$T/src/faucet-thing.timer"
  # These two must never be copied by the running script: it IS one of them, and bash
  # reads a script lazily, so overwriting the file the interpreter is still reading can
  # resume it mid-line in different text.
  printf 'faucet-thing.timer\n# a comment\n\n' > "$T/src/enabled-units"
  printf '#!/usr/bin/env bash\necho installer\n'  > "$T/src/install-ops.sh"
  printf '#!/usr/bin/env bash\necho autodeploy\n' > "$T/src/auto-deploy.sh"
}

echo "== install-ops: a normal run puts every script and unit on the box"
ops_env
bash "$INSTALL_OPS" "$T/src" > "$T/ok.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "watchdog.sh arrived" "[ -f '$T/install/watchdog.sh' ]"
check "audit-drift.sh arrived, the file that was missing for weeks" \
  "[ -f '$T/install/audit-drift.sh' ]"
check "alert.sh arrived, which the others call by sibling path" "[ -f '$T/install/alert.sh' ]"
check "the unit arrived in the unit dir, not the install dir" \
  "[ -f '$T/units/faucet-thing.service' ] && [ ! -f '$T/install/faucet-thing.service' ]"
check "the timer arrived too" "[ -f '$T/units/faucet-thing.timer' ]"
check "scripts are executable" "[ -x '$T/install/watchdog.sh' ]"
# Self-overwrite hazard: the running shell is still reading one of these.
check "it does NOT copy itself" "[ ! -f '$T/install/install-ops.sh' ]"
check "and does not copy auto-deploy.sh either" "[ ! -f '$T/install/auto-deploy.sh' ]"
check "and it says the end state was verified rather than just claiming done" \
  "grep -q 'verified: every ops script and unit' '$T/ok.log'"

echo "== install-ops: THE BUG. source == destination must be refused, not reported as success"
# Exactly what auto-deploy did: run the installed copy, whose own directory is the
# destination. Every copy is a file onto itself and every missing file is invisible.
ops_env
cp "$INSTALL_OPS" "$T/install/install-ops.sh"
cp "$T/src/watchdog.sh" "$T/install/watchdog.sh"      # one file already there
bash "$T/install/install-ops.sh" > "$T/same.log" 2>&1
check "a run whose source IS the destination exits NONZERO" "[ $? -ne 0 ]"
check "and says it is refusing" "grep -q 'REFUSING TO RUN' '$T/same.log'"
check "and names both paths so the operator can see they are one path" \
  "grep -q 'the source directory and the install directory are the same' '$T/same.log'"
# The consequence is the part worth stating, because the old behaviour looked healthy.
check "and explains that it would have installed NOTHING and exited 0" \
  "grep -q 'install NOTHING and exit 0' '$T/same.log'"
check "and does NOT print a success line" "! grep -q 'done: ' '$T/same.log'"
# The file that was already there must not be counted as an install.
check "and audit-drift.sh is still absent, which is the damage it refuses to hide" \
  "[ ! -f '$T/install/audit-drift.sh' ]"

echo "== install-ops: a source directory with no scripts is a wrong path, not an empty job"
# Without this the loops iterate zero times, nothing is copied, and the run reports
# success. That is the same false pass arriving through a typo instead of a glob.
ops_env
mkdir -p "$T/empty"
bash "$INSTALL_OPS" "$T/empty" > "$T/empty.log" 2>&1
check "an empty source exits NONZERO" "[ $? -ne 0 ]"
check "and says it is not the ops source directory" \
  "grep -q 'not the ops source directory' '$T/empty.log'"
check "and names installing nothing while reporting success as the failure it prevents" \
  "grep -q 'reporting success is the failure' '$T/empty.log'"

echo "== install-ops: a source path that does not exist is refused before anything runs"
ops_env
bash "$INSTALL_OPS" "$T/no-such-dir" > "$T/nodir.log" 2>&1
check "a missing source exits NONZERO" "[ $? -ne 0 ]"
check "and says the directory does not exist" "grep -q 'does not exist' '$T/nodir.log'"

echo "== install-ops: a file that cannot be written FAILS the run"
# The post-condition's whole job. The copy of this file fails, nothing else does, and
# before the post-condition existed the run would still have finished and said done.
ops_env
mkdir -p "$T/install/watchdog.sh"   # a directory where a file must go: install cannot win
bash "$INSTALL_OPS" "$T/src" > "$T/unwritable.log" 2>&1
check "a file that could not be placed FAILS the run" "[ $? -ne 0 ]"
check "and the failure is reported per file" "grep -qE 'could not install|POST-CONDITION FAILED' '$T/unwritable.log'"
check "and it does not claim the box matches the repo" \
  "! grep -q 'verified: every ops script and unit' '$T/unwritable.log'"

echo "== install-ops: a re-run changes nothing and says so"
ops_env
bash "$INSTALL_OPS" "$T/src" > /dev/null 2>&1
: > "$STUB_ENABLED"
bash "$INSTALL_OPS" "$T/src" > "$T/rerun.log" 2>&1
check "a re-run exits 0" "[ $? -eq 0 ]"
check "and installs nothing the second time" "grep -q 'done: 0 installed' '$T/rerun.log'"
check "and still verifies the end state rather than skipping the check" \
  "grep -q 'verified: every ops script and unit' '$T/rerun.log'"
# A reload on a no-change run is noise that teaches people to stop reading the log.
check "and does not reload systemd when no unit changed" \
  "! grep -q 'reloaded systemd' '$T/rerun.log'"

echo "== install-ops: stale content on the box is replaced, not left alone"
# Drift the other way: the file exists but is not what we reviewed. audit-drift reports
# this; the installer has to fix it.
ops_env
bash "$INSTALL_OPS" "$T/src" > /dev/null 2>&1
echo "# edited by hand on the box" >> "$T/install/watchdog.sh"
bash "$INSTALL_OPS" "$T/src" > "$T/stale.log" 2>&1
check "a hand-edited script is replaced" \
  "cmp -s '$T/src/watchdog.sh' '$T/install/watchdog.sh'"
check "and the run reports the install" "grep -q 'installed watchdog.sh' '$T/stale.log'"

echo "== install-ops: --dry-run reports what it WOULD do and touches nothing"
ops_env
bash "$INSTALL_OPS" --dry-run "$T/src" > "$T/dry.log" 2>&1
check "dry run exits 0" "[ $? -eq 0 ]"
check "and names a file it would install" "grep -q 'would install' '$T/dry.log'"
check "and nothing actually arrived" "[ ! -f '$T/install/watchdog.sh' ]"
# It must not claim verification either: nothing was placed, so there is nothing true to say.
check "and it does not claim the end state was verified" \
  "! grep -q 'verified: every ops script and unit' '$T/dry.log'"

echo "== install-ops: the repo declares what must be ENABLED, and the installer enforces it"
# Installed-but-not-enabled works until the next reboot and then silently does not. It is
# also what actually happened: faucet-box-report.timer was never enabled, its report aged
# past the 30-minute staleness window, and the public probe went red on a faucet that was
# serving perfectly well.
ops_env
bash "$INSTALL_OPS" "$T/src" > "$T/enable.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "the declared timer was enabled" "grep -qx 'faucet-thing.timer' '$STUB_ENABLED'"
check "and it says so" "grep -q 'enabled faucet-thing.timer' '$T/enable.log'"
check "and the post-condition covers enablement, not only files" \
  "grep -q 'every declared unit is enabled' '$T/enable.log'"
# A comment and a blank line in the declaration must not become unit names.
check "comments and blanks in the declaration are ignored" \
  "! grep -qE '^(#|$)' '$STUB_ENABLED'"

echo "== install-ops: a declared unit that will not enable FAILS the run"
# Enabling is the point of the file; a failure there is not a warning to walk past.
ops_env
printf 'faucet-thing.timer\nnot-shipped.timer\n' > "$T/src/enabled-units"
bash "$INSTALL_OPS" "$T/src" > "$T/enablefail.log" 2>&1
check "a declared unit that is not installed FAILS the run" "[ $? -ne 0 ]"
check "and names it as not-installed rather than as a systemd error" \
  "grep -q 'not-shipped.timer(not-installed)' '$T/enablefail.log'"
check "and does not claim the box is at spec" \
  "! grep -q 'every declared unit is enabled' '$T/enablefail.log'"

echo "== install-ops: nothing NOT declared is enabled, and nothing is ever disabled"
# The money path. Listing the miner would mean any box installing this repo starts mining,
# and disabling on a running box is not a decision a file sync should make.
ops_env
printf 'zcash-testnet-miner.service\n' > "$T/src/zcash-testnet-miner.service"
printf 'faucet-thing.timer\n' > "$T/src/enabled-units"
printf 'operator-enabled-this.timer\n' > "$STUB_ENABLED"
bash "$INSTALL_OPS" "$T/src" > "$T/undeclared.log" 2>&1
check "an undeclared unit is NOT enabled" "! grep -qx 'zcash-testnet-miner.service' '$STUB_ENABLED'"
check "and what the operator had enabled is left alone" \
  "grep -qx 'operator-enabled-this.timer' '$STUB_ENABLED'"
check "and the run says untouched units were left as they were" \
  "grep -q 'left exactly as they were' '$T/undeclared.log'"

echo "== install-ops: a re-run does not re-enable what is already enabled"
ops_env
bash "$INSTALL_OPS" "$T/src" > /dev/null 2>&1
bash "$INSTALL_OPS" "$T/src" > "$T/reenable.log" 2>&1
check "a re-run exits 0" "[ $? -eq 0 ]"
check "and reports 0 newly enabled" "grep -q '0 newly enabled' '$T/reenable.log'"
