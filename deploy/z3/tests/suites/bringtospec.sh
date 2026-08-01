# shellcheck shell=bash
# bring-to-spec.sh: one command that brings a box to spec, or refuses.
#
# Written with the failure paths reachable FIRST, because the last three PRs each shipped
# an assertion that could not see its subject. Every check here is proven by deleting the
# thing it watches, and the doubles are faithful rather than convenient: cargo really
# produces a binary, the report really carries counts, and a rebuild really depends on
# whether the sources are newer.

SPEC="$REPO/deploy/z3/bring-to-spec.sh"

spec_env() {
  mk_scratch "${TMPDIR:-/tmp}/spec-test.XXXXXX"
  export PATH="$SCRATCH/stubs:$BASE_PATH"
  mkdir -p "$T/src/miner/src" "$T/install" "$T/units" "$T/bin" "$T/report"
  export SPEC_SOURCE_DIR="$T/src" SPEC_INSTALL_DIR="$T/install"
  export SPEC_MINER_BIN="$T/install/zcash-testnet-miner"
  export SPEC_REPORT="$T/report/box-integrity.json"
  export OPS_INSTALL_DIR="$T/install" OPS_UNIT_DIR="$T/units"
  export OPS_SYSTEMCTL="$SCRATCH/stubs/audit-systemctl"
  export STUB_UNIT_DIR="$T/units"
  export STUB_ENABLED="$T/enabled"; : > "$STUB_ENABLED"
  export STUB_DISABLED="$T/disabled"; : > "$STUB_DISABLED"

  # An ops tree: install-ops and box-report are the real scripts, since composing them is
  # the entire point and stubbing them would test nothing.
  cp "$REPO/deploy/z3/install-ops.sh" "$T/src/install-ops.sh"
  printf '#!/usr/bin/env bash\necho watchdog\n' > "$T/src/watchdog.sh"
  printf '[Unit]\nDescription=t\nOnFailure=faucet-alert@%%n.service\n[Timer]\nOnCalendar=hourly\n[Install]\nWantedBy=timers.target\n' \
    > "$T/src/faucet-thing.timer"
  printf 'faucet-thing.timer\n' > "$T/src/enabled-units"
  printf 'fn main() {}\n' > "$T/src/miner/src/main.rs"

  # box-report is replaced by a writer we control, because what this suite tests is what
  # bring-to-spec DOES WITH the report, not how the report is produced. box-report has its
  # own suite for that. STUB_REPORT_* let a test say what the box looks like.
  cat > "$T/src/box-report.sh" <<'RPT'
#!/usr/bin/env bash
printf '{"expected":%s,"present":%s,"notEnabled":%s,"minerBinary":"%s","readable":true}\n' \
  "${STUB_REPORT_EXPECTED:-3}" "${STUB_REPORT_PRESENT:-3}" \
  "${STUB_REPORT_NOTENABLED:-0}" "${STUB_REPORT_MINER:-current}" > "${SPEC_REPORT:?}"
RPT
  chmod +x "$T/src/box-report.sh"

  # A cargo that behaves like cargo: it writes a real binary where cargo would.
  cat > "$T/bin/cargo" <<'CARGO'
#!/usr/bin/env bash
[ "${STUB_CARGO_FAIL:-0}" = "1" ] && { echo "error: could not compile (stub)" >&2; exit 101; }
mkdir -p target/release
# STUB_CARGO_NO_BINARY: exits 0 and produces nothing. A build that "succeeds" with no
# artifact is a real shape and the script has to notice it rather than install nothing.
[ "${STUB_CARGO_NO_BINARY:-0}" = "1" ] && exit 0
printf 'ELF-ish stub binary\n' > target/release/zcash-testnet-miner
chmod +x target/release/zcash-testnet-miner
exit 0
CARGO
  chmod +x "$T/bin/cargo"
  export SPEC_CARGO="$T/bin/cargo"
}

echo "== bring-to-spec: a good run installs, builds, reports, and PROVES it"
spec_env
bash "$SPEC" > "$T/ok.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "the ops script arrived" "[ -f '$T/install/watchdog.sh' ]"
check "the declared unit was enabled" "grep -qx 'faucet-thing.timer' '$STUB_ENABLED'"
check "THE MINER BINARY WAS BUILT AND INSTALLED, which nothing automated before" \
  "[ -x '$T/install/zcash-testnet-miner' ]"
check "and the run says the box is at spec" "grep -q 'box is at spec' '$T/ok.log'"
check "and it says what it verified rather than only that it finished" \
  "grep -qE 'verified: [0-9]+ of [0-9]+ present' '$T/ok.log'"

echo "== bring-to-spec: a box the report says is SHORT fails, even though every step worked"
# The whole reason step 4 exists. Each step can succeed while the box is still not at
# spec, because each one sees only its own slice.
spec_env
STUB_REPORT_PRESENT=2 STUB_REPORT_EXPECTED=3 bash "$SPEC" > "$T/short.log" 2>&1
check "a short box FAILS the run" "[ $? -ne 0 ]"
check "and it is reported as a post-condition, not as a step that errored" \
  "grep -q 'POST-CONDITION FAILED' '$T/short.log'"
check "and it prints the counts so the operator knows what is missing" \
  "grep -q 'present 2 of 3' '$T/short.log'"
check "and does NOT claim the box is at spec" "! grep -q 'box is at spec' '$T/short.log'"

echo "== bring-to-spec: a unit installed but not enabled fails too"
# Installed-but-disabled works until the next reboot and then silently does not.
spec_env
STUB_REPORT_NOTENABLED=1 bash "$SPEC" > "$T/nen.log" 2>&1
check "a not-enabled unit FAILS the run" "[ $? -ne 0 ]"
check "and the count is named" "grep -q 'not-enabled 1' '$T/nen.log'"

echo "== bring-to-spec: no report at all is UNVERIFIED, not success and not failure"
spec_env
rm -f "$T/src/box-report.sh"
bash "$SPEC" > "$T/norpt.log" 2>&1
check "a missing report FAILS rather than passing quietly" "[ $? -ne 0 ]"
check "and is reported as UNVERIFIED" "grep -q 'POST-CONDITION UNVERIFIED' '$T/norpt.log'"
check "and says the box may well be at spec, which is the honest state" \
  "grep -q 'may well be at spec' '$T/norpt.log'"

echo "== bring-to-spec: a failed miner build fails the run and names it"
spec_env
STUB_CARGO_FAIL=1 bash "$SPEC" > "$T/cargofail.log" 2>&1
check "a failed build FAILS the run" "[ $? -ne 0 ]"
check "and names miner-build so the operator knows where to look" \
  "grep -q 'miner-build' '$T/cargofail.log'"
check "and the stale binary is NOT left looking installed" \
  "[ ! -f '$T/install/zcash-testnet-miner' ]"

echo "== bring-to-spec: cargo exiting 0 with no binary is caught"
# A build that succeeds and produces nothing. Trusting the exit code alone would install
# nothing and report success, which is this programme's whole subject.
spec_env
STUB_CARGO_NO_BINARY=1 bash "$SPEC" > "$T/nobin.log" 2>&1
check "a build that produced no artifact FAILS" "[ $? -ne 0 ]"
check "and says the binary was not produced" \
  "grep -q 'no-binary-produced' '$T/nobin.log'"

echo "== bring-to-spec: a re-run does NOT rebuild a binary that is already current"
# A rebuild costs minutes of CPU on a small box, so a no-op run must be a no-op.
spec_env
bash "$SPEC" > /dev/null 2>&1
sleep 1
bash "$SPEC" > "$T/rerun.log" 2>&1
check "a re-run exits 0" "[ $? -eq 0 ]"
check "and skips the build, saying why" \
  "grep -q 'newer than its sources, no rebuild needed' '$T/rerun.log'"

echo "== bring-to-spec: a source change DOES trigger a rebuild"
# The other direction. Without this the skip above could be permanent and look correct.
spec_env
bash "$SPEC" > /dev/null 2>&1
sleep 1
touch "$T/src/miner/src/main.rs"
bash "$SPEC" > "$T/rebuild.log" 2>&1
check "a newer source triggers a rebuild" "grep -q 'building the miner' '$T/rebuild.log'"
check "and the run still exits 0" "[ $? -eq 0 ]"

echo "== bring-to-spec: no cargo is named, not silently skipped"
spec_env
SPEC_CARGO="$T/bin/no-such-cargo" bash "$SPEC" > "$T/nocargo.log" 2>&1
check "a host without cargo FAILS rather than reporting spec" "[ $? -ne 0 ]"
check "and says the binary cannot be built or checked" \
  "grep -q 'cannot be built or checked' '$T/nocargo.log'"

echo "== bring-to-spec: a wrong source directory is refused before anything runs"
spec_env
mkdir -p "$T/empty"
SPEC_SOURCE_DIR="$T/empty" bash "$SPEC" > "$T/emptysrc.log" 2>&1
check "an empty source exits nonzero" "[ $? -ne 0 ]"
check "and says it is not the ops source directory" \
  "grep -q 'not the ops source directory' '$T/emptysrc.log'"
check "and nothing was installed" "[ ! -f '$T/install/watchdog.sh' ]"

echo "== bring-to-spec: --dry-run changes nothing and claims nothing"
spec_env
bash "$SPEC" --dry-run > "$T/dry.log" 2>&1
check "dry run exits 0" "[ $? -eq 0 ]"
check "nothing was installed" "[ ! -f '$T/install/watchdog.sh' ]"
check "no binary was built" "[ ! -f '$T/install/zcash-testnet-miner' ]"
# It must not claim verification either: nothing changed, so there is nothing true to say.
check "and it does not claim the box is at spec" "! grep -q 'box is at spec' '$T/dry.log'"
check "and says why there is no post-condition" \
  "grep -q 'no post-condition, because nothing was changed' '$T/dry.log'"
