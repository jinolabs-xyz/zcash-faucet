# shellcheck shell=bash
# install-ops.sh: the script that puts our ops code on the box.
#
# IT HAD NO SUITE AT ALL, and that is why it shipped broken for weeks. It took its
# source directory from its own location, and auto-deploy.sh installs it to /opt/faucet
# and runs the INSTALLED copy - so on the box the source WAS the destination. It globbed
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
  # Records any `systemctl disable` call. App reviewed this PR by SABOTAGING the code and
  # found the suite stayed green: "nothing is ever disabled" was asserted by a heading and
  # by no assertion, and a property nothing checks survives exactly until someone edits the
  # file. This is what makes it checkable.
  export STUB_DISABLED="$T/disabled"; : > "$STUB_DISABLED"
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
# App's line, and the merge condition on this PR. Turning something OFF on a running box is
# not a decision a file sync should make, and until now nothing proved we do not.
check "systemctl disable was never called" "[ ! -s '$STUB_DISABLED' ]"

echo "== install-ops: a re-run does not re-enable what is already enabled"
ops_env
bash "$INSTALL_OPS" "$T/src" > /dev/null 2>&1
bash "$INSTALL_OPS" "$T/src" > "$T/reenable.log" 2>&1
check "a re-run exits 0" "[ $? -eq 0 ]"
check "and reports 0 newly enabled" "grep -q '0 newly enabled' '$T/reenable.log'"

echo "== install-ops: the disable assertion can actually FAIL"
# A negative assertion that cannot fail is decoration. This proves the recorder works, so
# the check above is evidence rather than a heading. Rule 29, applied to App's own line.
ops_env
"$OPS_SYSTEMCTL" disable faucet-thing.timer >/dev/null 2>&1
check "a disable call IS recorded, so the assertion above can fail" "[ -s '$STUB_DISABLED' ]"
check "and it names the unit" "grep -qx 'faucet-thing.timer' '$STUB_DISABLED'"

echo "== install-ops: A DROP-IN IN A .service.d DIRECTORY REACHES THE BOX"
# The gap this closes. Every glob in this script was top-level, so a file in a
# subdirectory was reviewed, merged, and never installed -- and because it was in the
# repo, it read as shipped. Found the day ctaz-node.service.d landed, where the missing
# file would have cost a rebuilt box its sync tuning with nothing saying so.
ops_env
mkdir -p "$T/src/faucet-thing.service.d"
printf '[Service]\nCPUQuota=200%%\n' > "$T/src/faucet-thing.service.d/10-tuning.conf"
bash "$INSTALL_OPS" "$T/src" > "$T/dropin.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "the drop-in arrived beside the unit, not in the install dir" \
  "[ -f '$T/units/faucet-thing.service.d/10-tuning.conf' ] && [ ! -f '$T/install/10-tuning.conf' ]"
check "and it is the same file, not an empty one with the right name" \
  "cmp -s '$T/src/faucet-thing.service.d/10-tuning.conf' '$T/units/faucet-thing.service.d/10-tuning.conf'"
check "a changed unit tree triggers the daemon-reload" "grep -q 'reloaded systemd' '$T/dropin.log'"

echo "== install-ops: a drop-in that CANNOT be written fails the run and is named"
# The post-condition half. An install rule without a matching post-condition check is
# how a file goes missing quietly, which is the whole reason those loops exist.
ops_env
mkdir -p "$T/src/faucet-thing.service.d"
printf '[Service]\nCPUQuota=200%%\n' > "$T/src/faucet-thing.service.d/10-tuning.conf"
mkdir -p "$T/units/faucet-thing.service.d"
chmod 500 "$T/units/faucet-thing.service.d"
bash "$INSTALL_OPS" "$T/src" > "$T/dropinfail.log" 2>&1
dropin_rc=$?
chmod 700 "$T/units/faucet-thing.service.d"
check "a drop-in that could not be installed exits NONZERO" "[ $dropin_rc -ne 0 ]"
check "and the run names the file rather than the directory alone" \
  "grep -q '10-tuning.conf' '$T/dropinfail.log'"

echo "== install-ops: a DECLARED asset directory reaches the box"
# ctaz-build/Dockerfile is not a script and not a unit, but ctaz-build.sh reads it from
# /opt/faucet. Declared in ASSET_DIRS rather than globbed: "install every subdirectory"
# would sweep in miner/target, which is hundreds of megabytes of build output.
ops_env
mkdir -p "$T/src/ctaz-build"
printf 'FROM scratch\n' > "$T/src/ctaz-build/Dockerfile"
bash "$INSTALL_OPS" "$T/src" > "$T/asset.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "the Dockerfile arrived under its own directory" "[ -f '$T/install/ctaz-build/Dockerfile' ]"
check "and matches the source" "cmp -s '$T/src/ctaz-build/Dockerfile' '$T/install/ctaz-build/Dockerfile'"

echo "== install-ops: A SUBDIRECTORY NOTHING INSTALLS IS NAMED, not passed over in silence"
# The bug was never a missing rule, it was that the absence was silent: an unwired
# subdirectory looked exactly like one that needs nothing. This is what makes the next
# one visible on the first run instead of on the first rebuild.
ops_env
mkdir -p "$T/src/somethingnew" "$T/src/tests" "$T/src/miner/target"
printf 'x\n' > "$T/src/somethingnew/thing.conf"
printf 'x\n' > "$T/src/tests/run.sh"
printf 'x\n' > "$T/src/miner/target/artifact"
bash "$INSTALL_OPS" "$T/src" > "$T/unknown.log" 2>&1
check "exits 0, because an unwired directory is a note and not a failure" "[ $? -eq 0 ]"
check "the run NAMES the unwired directory" "grep -q 'somethingnew/ holds files' '$T/unknown.log'"
check "and does not nag about tests/, which never runs on the box" \
  "! grep -q 'tests/ holds files' '$T/unknown.log'"
check "nor about miner/, which ships as a built binary and not as a tree" \
  "! grep -q 'miner/ holds files' '$T/unknown.log'"
check "and it did not install the unwired directory behind our backs" \
  "[ ! -e '$T/install/somethingnew' ]"

echo "== install-ops: THE DROP-IN POST-CONDITION CAN ACTUALLY FAIL"
# #361 added an install loop for .service.d drop-ins AND a matching post-condition, on the
# stated grounds that "an install rule without a matching post-condition is how a file goes
# missing quietly". The install loop was tested three ways. The post-condition was tested by
# nothing: deleting only that loop left the suite at 64 passed 0 failed.
#
# So the guard against silent-missing was itself unguarded, in the PR about a file that was
# reviewed, merged and never installed. That is the same shape one level up.
#
# The scenario the post-condition exists for is a drop-in that cannot be placed. Made real by
# taking write permission off the destination directory, so `place` fails for that ONE file
# while everything else installs normally - which is what makes this a test of the
# post-condition rather than of the whole run collapsing.
ops_env
mkdir -p "$T/src/faucet-thing.service.d"
printf '[Service]\nCPUQuota=200%%\n' > "$T/src/faucet-thing.service.d/10-tuning.conf"
mkdir -p "$T/units/faucet-thing.service.d"
chmod 500 "$T/units/faucet-thing.service.d"
bash "$INSTALL_OPS" "$T/src" > "$T/dropfail.log" 2>&1
rc=$?
chmod 700 "$T/units/faucet-thing.service.d"   # restore before assertions so cleanup works
check "a drop-in that cannot be placed FAILS the run" "[ $rc -ne 0 ]"
check "and the post-condition names it by <dir>/<file>, not just the basename" \
  "grep -q 'never arrived:.*faucet-thing.service.d/10-tuning.conf' '$T/dropfail.log'"
check "and the run does not report the box as installed" \
  "! grep -qE 'all [0-9]+ (file|item)s? installed' '$T/dropfail.log'"
# The scripts and top-level units must still have landed. If the whole run aborted early this
# assertion fails, and the test above would have been passing for the wrong reason.
check "and the rest of the tree DID install, so this isolates the post-condition" \
  "[ -f '$T/install/watchdog.sh' ] && [ -f '$T/units/faucet-thing.timer' ]"

echo "== install-ops: a drop-in that is present but STALE is reported as differing"
# The other half of the same post-condition. Missing and stale are different repairs: absent
# points at the install rule, stale points at a copy that silently did not overwrite.
ops_env
mkdir -p "$T/src/faucet-thing.service.d" "$T/units/faucet-thing.service.d"
printf '[Service]\nCPUQuota=200%%\n' > "$T/src/faucet-thing.service.d/10-tuning.conf"
printf '[Service]\nCPUQuota=999%%\n' > "$T/units/faucet-thing.service.d/10-tuning.conf"
chmod 500 "$T/units/faucet-thing.service.d"
bash "$INSTALL_OPS" "$T/src" > "$T/dropstale.log" 2>&1
rc=$?
chmod 700 "$T/units/faucet-thing.service.d"
check "a drop-in that could not be updated FAILS the run" "[ $rc -ne 0 ]"
check "and it is reported, by one of the two states, rather than passing silently" \
  "grep -qE '(never arrived|differ).*10-tuning.conf' '$T/dropstale.log'"

echo "== install-ops: a .socket unit is installed and enabled like any other (#409)"
# A unit type the repo ships and install-ops does not glob is a required file that is
# never installed, on a box that reports complete. That is this script's own founding
# bug - its header says "19 of 25 required files sat uninstalled for weeks" - and socket
# units were outside the glob until cTAZ needed one.
ops_env
mkdir -p "$T/src"
printf '#!/usr/bin/env bash\ntrue\n' > "$T/src/probe.sh"
printf '[Unit]\nDescription=t\n[Socket]\nListenStream=/tmp/t.sock\n[Install]\nWantedBy=sockets.target\n' > "$T/src/probe-rpc.socket"
bash "$INSTALL_OPS" "$T/src" > "$T/sock.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "the socket unit landed in the unit dir" "[ -f '$OPS_UNIT_DIR/probe-rpc.socket' ]"
check "and matches the source, so a stale copy is not counted as installed" \
  "cmp -s '$T/src/probe-rpc.socket' '$OPS_UNIT_DIR/probe-rpc.socket'"
# And a DECLARED socket is enabled. Socket units are the one type where this matters
# most: nothing else starts them, so an installed-but-not-enabled socket is a channel
# that exists on disk and answers nothing after the next reboot.
printf 'faucet-thing.timer\nprobe-rpc.socket\n' > "$T/src/enabled-units"
bash "$INSTALL_OPS" "$T/src" > "$T/sock2.log" 2>&1
check "a declared socket unit is enabled" "grep -qx 'probe-rpc.socket' '$STUB_ENABLED'"
check "and nothing was disabled on the way" "[ ! -s '$STUB_DISABLED' ]"
