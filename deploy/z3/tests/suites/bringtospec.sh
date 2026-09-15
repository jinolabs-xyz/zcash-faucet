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
# STUB_REPORT_NOMINER: emit a report with no minerBinary field at all, which is what an
# older box-report.sh on a box that has not been updated yet actually writes.
if [ "${STUB_REPORT_NOMINER:-0}" = "1" ]; then
  printf '{"expected":%s,"present":%s,"notEnabled":%s,"readable":true}\n' \
    "${STUB_REPORT_EXPECTED:-3}" "${STUB_REPORT_PRESENT:-3}" \
    "${STUB_REPORT_NOTENABLED:-0}" > "${STUB_REPORT_PATH:-${SPEC_REPORT:?}}"
else
  printf '{"expected":%s,"present":%s,"notEnabled":%s,"minerBinary":"%s","readable":true}\n' \
    "${STUB_REPORT_EXPECTED:-3}" "${STUB_REPORT_PRESENT:-3}" \
    "${STUB_REPORT_NOTENABLED:-0}" "${STUB_REPORT_MINER:-current}" > "${STUB_REPORT_PATH:-${SPEC_REPORT:?}}"
fi
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

echo "== bring-to-spec: A STALE MINER BINARY FAILS, which is the condition this script exists for"
# Found in review (SDE-App, #319). The post-condition read minerBinary and only PRINTED it:
# the gate was present-vs-expected and notEnabled. So a box whose report said the binary was
# stale exited 0 with "box is at spec", and the word `verified` appeared on the same line as
# the word `stale`. That is the four-day-old-binary incident reproduced exactly, by the one
# command written to prevent it.
#
# The build has to SUCCEED here to isolate the post-condition. An earlier run of App's
# exited 1 from miner-build(no-binary-produced), which would have looked like the check
# working while the check contributed nothing.
spec_env
STUB_REPORT_MINER=stale bash "$SPEC" > "$T/stale.log" 2>&1
check "a stale binary FAILS the run" "[ $? -ne 0 ]"
check "and the build itself did NOT fail, so it is the post-condition talking" \
  "! grep -q 'miner-build' '$T/stale.log'"
check "and it does NOT claim the box is at spec" "! grep -q 'box is at spec' '$T/stale.log'"
check "and the word verified never appears next to a stale binary" \
  "! grep -q 'verified:.*stale' '$T/stale.log'"
check "and the state is named so the operator knows what to do" \
  "grep -q 'miner binary stale' '$T/stale.log'"

echo "== bring-to-spec: an absent miner binary fails too"
spec_env
STUB_REPORT_MINER=absent bash "$SPEC" > "$T/absent.log" 2>&1
check "an absent binary FAILS the run" "[ $? -ne 0 ]"
check "and does not claim spec" "! grep -q 'box is at spec' '$T/absent.log'"

echo "== bring-to-spec: a report with no minerBinary field FAILS CLOSED"
# An older box-report.sh that predates the field must not silently satisfy the check the
# field exists for. Absence of evidence is the thing this whole programme refuses to read
# as evidence of absence of a problem.
spec_env
STUB_REPORT_NOMINER=1 bash "$SPEC" > "$T/nominer.log" 2>&1
check "a report missing the field FAILS rather than passing" "[ $? -ne 0 ]"
check "and says the state is unknown rather than inventing one" \
  "grep -q 'miner binary state is unknown' '$T/nominer.log'"
check "and is UNVERIFIED rather than a claim the box is broken" \
  "grep -q 'POST-CONDITION UNVERIFIED' '$T/nominer.log'"

echo "== bring-to-spec: known-bad exits 1 and cannot-verify exits 2, exactly"
# Its own two-state vocabulary (redeploy.sh has a third code of its own). The script already
# distinguished these two states in its PROSE and collapsed them in its exit code, which
# throws away the more useful of the two facts.
spec_env
STUB_REPORT_PRESENT=2 STUB_REPORT_EXPECTED=3 bash "$SPEC" > "$T/code1.log" 2>&1
check "a box the report says is SHORT exits exactly 1 (known-bad)" "[ $? -eq 1 ]"

spec_env
rm -f "$T/src/box-report.sh"
bash "$SPEC" > "$T/code2.log" 2>&1
check "a run that could not read a report exits exactly 2 (cannot-verify)" "[ $? -eq 2 ]"

spec_env
STUB_REPORT_MINER=stale bash "$SPEC" > /dev/null 2>&1
check "a stale binary is known-bad, so exactly 1" "[ $? -eq 1 ]"

echo "== bring-to-spec: known-bad outranks cannot-verify when both happen"
# A definite fault plus an unanswered question is still a definite fault, and reporting the
# weaker of the two would be the wrong call. no-cargo is cannot-verify, a short report is
# known-bad; together the run must come out 1 and must still MENTION the thing it could not
# verify rather than dropping it on the floor.
spec_env
SPEC_CARGO="$T/bin/no-such-cargo" STUB_REPORT_PRESENT=2 STUB_REPORT_EXPECTED=3 \
  bash "$SPEC" > "$T/both.log" 2>&1
check "known-bad plus cannot-verify exits 1, not 2" "[ $? -eq 1 ]"
check "and the cannot-verify part is still reported, not swallowed" \
  "grep -q 'also could not verify:.*no-cargo' '$T/both.log'"

echo "== bring-to-spec: a box with NO miner sources is not failed for lacking a binary"
# untracked is not a fault. box-report does not even add it to `expected`, so treating it
# like stale would fail every box that legitimately has no miner, and a gate that cries
# wolf on correct boxes gets ignored on the one that matters.
spec_env
rm -rf "$T/src/miner"
STUB_REPORT_MINER=untracked bash "$SPEC" > "$T/untracked.log" 2>&1
check "a box with no miner sources still exits 0" "[ $? -eq 0 ]"
check "and says the box is at spec" "grep -q 'box is at spec' '$T/untracked.log'"

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

echo "== bring-to-spec: the report is read from the volume docker names, not a path that never existed (R-42)"
# SPEC_REPORT unset is what production runs with. The old default pointed at
# z3_faucet_data, a volume no compose project here ever created, so every prod run ended
# "could not verify" with exit 2 while box-report wrote its file under
# zcash-faucet_faucet_data. Now docker is asked for the mountpoint.
spec_env
unset SPEC_REPORT
export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
export STUB_VOLROOT="$T/vols"
mkdir -p "$T/vols/zcash-faucet_faucet_data"
export STUB_REPORT_PATH="$T/vols/zcash-faucet_faucet_data/box-integrity.json"
bash "$SPEC" > "$T/volume.log" 2>&1
check "with the report where box-report writes it, the post-condition is verified and exits 0" "[ $? -eq 0 ]"
check "docker was asked for the volume's mountpoint" "grep -q 'docker volume inspect -f {{.Mountpoint}} zcash-faucet_faucet_data' '$STUB_LOG'"
check "and the box is declared at spec" "grep -q 'box is at spec' '$T/volume.log'"
check "and the dead volume name is gone from the script" "! grep -q 'z3_faucet_data' '$REPO/deploy/z3/bring-to-spec.sh'"
# No such volume: the fallback path is the stock daemon's for that name, and the run says
# cannot-verify at THAT path, so an operator reads a path that could exist.
spec_env
unset SPEC_REPORT
export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
export STUB_VOLROOT="$T/vols"; mkdir -p "$T/vols"
export STUB_REPORT_PATH="$T/report/elsewhere.json"
bash "$SPEC" > "$T/novolume.log" 2>&1
check "with no such volume the post-condition is unverified, exit 2" "[ $? -eq 2 ]"
check "and it names the stock path for the real volume name, not z3_faucet_data" \
  "grep -q 'no integrity report at /var/lib/docker/volumes/zcash-faucet_faucet_data/_data/box-integrity.json' '$T/novolume.log'"

echo "== bring-to-spec and box-report resolve the SAME path, each from its own code"
# THE SEAM, not either half. The two cases above pin STUB_REPORT_PATH, so they prove the
# READER's default and say nothing about where the writer puts the file. Until box-report
# derived its own path, this script asked docker (#542, R-42) while box-report.sh carried a
# hard-coded /var/lib/docker/volumes/... copy: on a daemon with a non-stock data-root the
# reader looked where docker said and the writer wrote where a stock daemon would have put
# it, the post-condition read "no integrity report" forever, and neither half was wrong on
# its own - which is exactly why nothing said so.
#
# NEITHER PATH IS STATED HERE. The reader NAMES its own default in the line it prints when
# the report is absent; the writer simply writes to its own and we look for the file there.
# So editing one script's derivation and not the other fails this, which a test that spelled
# the path out would not.
spec_env
unset SPEC_REPORT
export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
# A NON-STOCK data-root, which is the whole point: under the stock one the two defaults
# coincide by accident and this case could not fail.
export STUB_VOLROOT="$T/dockerroot/volumes"
mkdir -p "$STUB_VOLROOT/zcash-faucet_faucet_data"
# The double writes where the post-condition will not look, so the run reaches its
# cannot-verify path and prints the path its own default resolved to.
export STUB_REPORT_PATH="$T/report/elsewhere.json"
bash "$SPEC" > "$T/seam.log" 2>&1
reader_path="$(sed -n 's/.*no integrity report at \(.*\)\./\1/p' "$T/seam.log" | head -1)"
check "the reader derived its path from docker, under the non-stock root" \
  "[ -n '$reader_path' ] && [ '$reader_path' = '$STUB_VOLROOT/zcash-faucet_faucet_data/box-integrity.json' ]"
# Now the REAL writer, its own default, the same stub daemon, pointed at the ops tree
# spec_env already built. Whether that box comes out AT SPEC is a different question and
# not this case's; all this asks is where the file lands.
mkdir -p "$T/repohome/deploy"
ln -sfn "$T/src" "$T/repohome/deploy/z3"
( unset BOX_REPORT_OUT
  BOX_REPORT_REPO="$T/repohome" BOX_REPORT_INSTALL_DIR="$T/install" \
  BOX_REPORT_UNIT_DIR="$T/units" BOX_REPORT_SYSTEMCTL="$SCRATCH/stubs/audit-systemctl" \
  bash "$REPO/deploy/z3/box-report.sh" ) > /dev/null 2>&1
check "and the writer, told no path either, wrote to exactly the file the reader named" \
  "[ -s '$reader_path' ]"
check "and both of them asked docker the same question" \
  "[ \"\$(grep -c 'docker volume inspect -f {{.Mountpoint}} zcash-faucet_faucet_data' '$STUB_LOG')\" -ge 2 ]"

echo "== bring-to-spec and box-report fall back to the SAME path when docker cannot answer"
# THE OTHER HALF OF THE SEAM. The case above proves the two agree when docker DOES name a
# mountpoint. This one is the branch that only runs when something is already wrong, which
# is exactly when a disagreement would be hardest to see - and it was previously asserted
# by grepping both scripts for the same literal string, two guesses about a format rather
# than one observation (review of #550).
#
# Neither path is spelled out here. The reader NAMES the path it would read in its own
# cannot-verify line; the writer WRITES to the path it chose; the assertion is that the
# two are the same string.
spec_env
unset SPEC_REPORT
export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
export STUB_VOLROOT="$T/empty"; mkdir -p "$STUB_VOLROOT"   # no volume of that name exists
# INLINE, NOT EXPORTED, for the reason the boxreport suite gives: one shell for every
# suite, so an export here is still set for whatever runs next.
shared_root="$T/shared"; mkdir -p "$shared_root"
export STUB_REPORT_PATH="$T/report/elsewhere.json"
SPEC_VOLUME_ROOT="$shared_root" SPEC_FAUCET_VOLUME="no-such-volume" \
  bash "$SPEC" > "$T/fallback.log" 2>&1
reader_fb="$(sed -n 's/.*no integrity report at \(.*\)\./\1/p' "$T/fallback.log" | head -1)"
check "the reader falls back and names the path it would have read" "[ -n '$reader_fb' ]"
# The same conditions on the writer's side, its own default, its own fallback.
mkdir -p "$T/repohome/deploy"
ln -sfn "$T/src" "$T/repohome/deploy/z3"
( unset BOX_REPORT_OUT
  BOX_REPORT_REPO="$T/repohome" BOX_REPORT_INSTALL_DIR="$T/install" \
  BOX_REPORT_UNIT_DIR="$T/units" BOX_REPORT_SYSTEMCTL="$SCRATCH/stubs/audit-systemctl" \
  BOX_REPORT_VOLUME_ROOT="$shared_root" BOX_REPORT_FAUCET_VOLUME="no-such-volume" \
  bash "$REPO/deploy/z3/box-report.sh" ) > /dev/null 2>&1
check "and the writer, falling back on its own, wrote to exactly that path" \
  "[ -s \"$reader_fb\" ]"
check "and both of them asked docker first rather than going straight to the guess" \
  "[ \"\$(grep -c 'docker volume inspect -f {{.Mountpoint}} no-such-volume' '$STUB_LOG')\" -ge 2 ]"

echo "== bring-to-spec and box-report agree on the PRODUCTION default, with no override set"
# THE HOLE THE OVERRIDE OPENED, found in review of #550. Adding *_VOLUME_ROOT made the
# fallback observable, and then every case set it - so the production default itself, the
# string that actually ships, went untested in both files at once. Moving the writer's
# default to somewhere else entirely left the suite green.
#
# Neither override is set here and nothing is written: with no mountpoint from docker each
# script RESOLVES its own production path and SAYS it, the writer on stderr and the reader
# in its cannot-verify line, and the assertion is that the two strings are the same one.
# That is why the path line exists at all, and it is the only way to compare these two
# without root on /var/lib/docker.
spec_env
unset SPEC_REPORT SPEC_VOLUME_ROOT BOX_REPORT_OUT BOX_REPORT_VOLUME_ROOT
export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
export STUB_VOLROOT="$T/empty"; mkdir -p "$STUB_VOLROOT"   # docker names no mountpoint
export STUB_REPORT_PATH="$T/report/elsewhere.json"
bash "$SPEC" > "$T/prod.log" 2>&1
reader_prod="$(sed -n 's/.*no integrity report at \(.*\)\./\1/p' "$T/prod.log" | head -1)"
mkdir -p "$T/repohome/deploy"
ln -sfn "$T/src" "$T/repohome/deploy/z3"
( BOX_REPORT_REPO="$T/repohome" BOX_REPORT_INSTALL_DIR="$T/install" \
  BOX_REPORT_UNIT_DIR="$T/units" BOX_REPORT_SYSTEMCTL="$SCRATCH/stubs/audit-systemctl" \
  bash "$REPO/deploy/z3/box-report.sh" ) > /dev/null 2>"$T/prod.err"
writer_prod="$(sed -n 's/^box-report: report path \(.*\) (.*$/\1/p' "$T/prod.err" | head -1)"
check "the reader resolved a production path and named it" "[ -n '$reader_prod' ]"
check "the writer resolved one and named it too" "[ -n '$writer_prod' ]"
check "and the two production defaults are the SAME path, with nothing overridden" \
  "[ \"$reader_prod\" = \"$writer_prod\" ]"
# Anchored once, deliberately: this is the string that ships, so a silent move of BOTH
# defaults together would otherwise still agree with itself.
check "and it is the stock daemon's path for the volume this project creates" \
  "[ \"$writer_prod\" = '/var/lib/docker/volumes/zcash-faucet_faucet_data/_data/box-integrity.json' ]"
