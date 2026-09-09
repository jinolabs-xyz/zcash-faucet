# shellcheck shell=bash
# auto-deploy.sh: the script that decides what reaches production, and until now the only
# ops script in this tree that NO suite invoked.
#
# HOW THAT WAS FOUND, because grep kept lying about it. Three greps for "does a suite
# mention this script" came back clean, then "does a suite EXECUTE it" came back with four
# false positives, because the invocation goes through a variable. So it was settled by
# OBSERVATION instead: every ops script was temporarily instrumented to append its own name
# to a log, the full suite was run once, and the names that never appeared were the answer.
# 18 of 19 scripts ran. auto-deploy.sh did not.
#
# That matters more for this script than for most. It pulls main, decides whether a commit
# is app-affecting or ops-affecting, installs the installer, runs it, and rebuilds the app.
# Its own header records two past bugs that made merged ops work dead on the box. Nothing
# was checking that the fixes for those stayed fixed.
#
# THE DOUBLE IS A REAL GIT REPO, not a git stub. This script's whole job is reading what
# changed between two commits, so a stub would be inventing the answer it is supposed to
# read. Real repo, real remote, real diff, real reset --hard.

AD="$REPO/deploy/z3/auto-deploy.sh"

ad_env() {
  mk_scratch "${TMPDIR:-/tmp}/autodeploy.XXXXXX"
  mkdir -p "$T/install"
  export AUTODEPLOY_REPO_DIR="$T/repo" AUTODEPLOY_INSTALL_DIR="$T/install"
  export INSTALLOPS_LOG="$T/installops.args" REDEPLOY_LOG="$T/redeploy.calls"
  : > "$INSTALLOPS_LOG"; : > "$REDEPLOY_LOG"
  # The stub systemctl keeps unit states as files here and logs every call, so a case
  # can say whether the miner was restarted, and from what state. Only systemctl is
  # stubbed: this suite's docker, curl and git are the real ones (or doubles in the repo
  # fixture), and the whole stubs dir on PATH would quietly swap them.
  export STUB_SYSTEMD="$T/systemd" STUB_LOG="$T/systemctl.calls"
  mkdir -p "$STUB_SYSTEMD" "$T/bin"; : > "$STUB_LOG"
  rm -f "$T/bin/systemctl"; ln -s "$SCRATCH/stubs/systemctl" "$T/bin/systemctl"
  export PATH="$T/bin:$BASE_PATH"

  # -b main on BOTH, and the remote added by hand rather than cloned. Cloning an EMPTY
  # bare repo leaves you on `master` with no remote HEAD, and the later work-clone then
  # fails to check out at all, so nothing is pushed and main never moves. The first
  # version of this fixture did exactly that: 17 assertions failed and every one of them
  # was the fixture, not the script. The fixture is now proven to advance main before any
  # assertion is trusted.
  git init -q --bare -b main "$T/origin.git"
  git init -q -b main "$T/repo"
  git -C "$T/repo" remote add origin "$T/origin.git"
  git -C "$T/repo" config user.email t@t; git -C "$T/repo" config user.name t
  mkdir -p "$T/repo/deploy/z3" "$T/repo/src"

  # The installer double lives in the REPO, because auto-deploy installs it from there and
  # then runs the INSTALLED copy. It records the arguments it was handed, which is the only
  # way to check the #290 fix: the installed copy must be given the repo as its source.
  cat > "$T/repo/deploy/z3/install-ops.sh" <<'IO'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$INSTALLOPS_LOG"
exit "${STUB_INSTALLOPS_RC:-0}"
IO
  chmod +x "$T/repo/deploy/z3/install-ops.sh"
  printf 'app\n' > "$T/repo/src/page.tsx"
  printf 'ops\n' > "$T/repo/deploy/z3/watchdog.sh"
  cp "$AD" "$T/repo/deploy/z3/auto-deploy.sh"
  git -C "$T/repo" add -A >/dev/null 2>&1
  git -C "$T/repo" commit -qm base >/dev/null 2>&1
  git -C "$T/repo" push -q -u origin main 2>/dev/null

  # redeploy.sh is run out of INSTALL_DIR, so it goes there directly.
  cat > "$T/install/redeploy.sh" <<'RD'
#!/usr/bin/env bash
printf 'called\n' >> "$REDEPLOY_LOG"
exit "${STUB_REDEPLOY_RC:-0}"
RD
  chmod +x "$T/install/redeploy.sh"
}

# Move main forward in the remote, touching exactly the paths asked for.
ad_advance() {
  local work="$T/work"
  rm -rf "$work"
  git clone -q -b main "$T/origin.git" "$work" 2>/dev/null
  git -C "$work" config user.email t@t; git -C "$work" config user.name t
  for p in "$@"; do
    mkdir -p "$work/$(dirname "$p")"
    printf 'changed %s\n' "$RANDOM" >> "$work/$p"
  done
  git -C "$work" add -A >/dev/null 2>&1
  git -C "$work" commit -qm "advance" >/dev/null 2>&1
  git -C "$work" push -q origin main 2>/dev/null
  # PROVE THE FIXTURE MOVED MAIN. A silent no-op here makes every downstream assertion
  # pass or fail for the wrong reason, which is how the first version of this file
  # produced 17 misleading failures.
  git -C "$T/repo" fetch -q origin main 2>/dev/null
  [ "$(git -C "$T/repo" rev-parse HEAD)" != "$(git -C "$T/repo" rev-parse origin/main)" ] \
    || bad "fixture did not advance main; every assertion below would be meaningless"
}

echo "== auto-deploy: nothing to do when main has not moved"
ad_env
bash "$AD" > "$T/noop.log" 2>&1
check "an unchanged main exits 0" "[ $? -eq 0 ]"
check "and says nothing to do" "grep -q 'nothing to do' '$T/noop.log'"
check "and does not touch the app" "[ ! -s '$REDEPLOY_LOG' ]"
check "and does not run the installer" "[ ! -s '$INSTALLOPS_LOG' ]"

echo "== auto-deploy: a missing repo fails, it does not quietly do nothing"
ad_env
AUTODEPLOY_REPO_DIR="$T/no-such-repo" bash "$AD" > "$T/norepo.log" 2>&1
check "a missing repo exits 1" "[ $? -eq 1 ]"
check "and names the path" "grep -q 'no repo at' '$T/norepo.log'"

echo "== auto-deploy: AN OPS-ONLY COMMIT INSTALLS OPS"
# Bug 1 from its own header: the filter did not match deploy/z3/*.sh, so a commit touching
# only watchdog.sh advanced the checkout and installed nothing, while the log said
# "nothing app-affecting" -- true of the web app, false of the box's supervision.
ad_env
ad_advance deploy/z3/watchdog.sh
bash "$AD" > "$T/ops.log" 2>&1
check "an ops-only commit exits 0" "[ $? -eq 0 ]"
check "and the installer ran" "[ -s '$INSTALLOPS_LOG' ]"
check "and it did NOT rebuild the app" "[ ! -s '$REDEPLOY_LOG' ]"
check "and the log states ops=1 app=0" "grep -q 'app=0 ops=1' '$T/ops.log'"

echo "== auto-deploy: THE INSTALLED INSTALLER IS GIVEN THE REPO AS ITS SOURCE"
# This is the #290 regression guard and the reason 19 of 25 files were never installed.
# Run with no argument, the installed copy took its own directory as the source, globbed
# the destination, copied files onto themselves and exited 0.
ad_env
ad_advance deploy/z3/watchdog.sh
bash "$AD" > /dev/null 2>&1
check "the installer was passed an explicit source" "[ -s '$INSTALLOPS_LOG' ]"
check "and that source is the REPO's ops dir, never the install dir" \
  "grep -qF '$T/repo/deploy/z3' '$INSTALLOPS_LOG'"
check "and it is not the destination" "! grep -qF '$T/install' '$INSTALLOPS_LOG'"

echo "== auto-deploy: an app-only commit rebuilds the app and not ops"
ad_env
ad_advance src/page.tsx
bash "$AD" > "$T/app.log" 2>&1
check "an app-only commit exits 0" "[ $? -eq 0 ]"
check "and redeploy ran" "[ -s '$REDEPLOY_LOG' ]"
check "and the installer did not" "[ ! -s '$INSTALLOPS_LOG' ]"

echo "== auto-deploy: a commit touching BOTH does both"
ad_env
ad_advance src/page.tsx deploy/z3/watchdog.sh
bash "$AD" > "$T/both.log" 2>&1
check "both paths run" "[ -s '$REDEPLOY_LOG' ] && [ -s '$INSTALLOPS_LOG' ]"
check "and the log says so" "grep -q 'app=1 ops=1' '$T/both.log'"

echo "== auto-deploy: a commit touching NEITHER says so rather than implying a deploy"
ad_env
ad_advance README.md
bash "$AD" > "$T/neither.log" 2>&1
check "a neutral commit exits 0" "[ $? -eq 0 ]"
check "and says it touched neither" "grep -q 'touched neither the app nor ops' '$T/neither.log'"

echo "== auto-deploy: A FAILED OPS INSTALL MUST NOT EXIT 0"
# The script's own closing comment: "A failed install must not exit 0. The timer's own
# status is the only signal anyone sees for this unit, and reporting success for a box that
# is not at spec is how the missing 19 files stayed invisible."
ad_env
ad_advance deploy/z3/watchdog.sh
STUB_INSTALLOPS_RC=1 bash "$AD" > "$T/opsfail.log" 2>&1
check "a failed install exits nonzero" "[ $? -ne 0 ]"
check "and says the box is not at spec" "grep -q 'not at spec' '$T/opsfail.log'"

echo "== auto-deploy: A FAILED OPS INSTALL STILL FAILS WHEN THE COMMIT ALSO TOUCHED THE APP"
# THE BUG THIS SUITE WAS WRITTEN TO CATCH. The app branch ends in `exit $?`, which is
# redeploy's status and discards rc from the ops install above it. So on a commit touching
# both, a failed ops install plus a healthy rebuild exits 0: the timer reports success, the
# app is fine, and the box is silently not at spec. That is the exact shape the closing
# comment forbids, defeated by an earlier exit.
ad_env
ad_advance src/page.tsx deploy/z3/watchdog.sh
STUB_INSTALLOPS_RC=1 STUB_REDEPLOY_RC=0 bash "$AD" > "$T/mixed.log" 2>&1
check "ops failed + app succeeded exits NONZERO" "[ $? -ne 0 ]"
check "and the ops failure is still reported" "grep -q 'install-ops FAILED' '$T/mixed.log'"
check "and the rebuild did happen, so the app is not held hostage to it" \
  "[ -s '$REDEPLOY_LOG' ]"

echo "== auto-deploy: a failed rebuild fails the run"
ad_env
ad_advance src/page.tsx
STUB_REDEPLOY_RC=7 bash "$AD" > "$T/appfail.log" 2>&1
check "a failed rebuild exits nonzero" "[ $? -ne 0 ]"

echo "== auto-deploy: it updates ITSELF for the next tick and does not re-exec"
# Overwriting the file a shell is still reading can resume the interpreter mid-line in new
# text. One cycle of lag is the deliberate, safe version.
ad_env
ad_advance deploy/z3/auto-deploy.sh
bash "$AD" > "$T/self.log" 2>&1
check "the new copy is installed" "[ -x '$T/install/auto-deploy.sh' ]"
check "and it says the new copy runs on the NEXT tick" \
  "grep -q 'runs on the NEXT tick' '$T/self.log'"
check "and it did not re-exec itself in this run" \
  "[ \$(grep -c 'auto-deploy.sh updated' '$T/self.log') -eq 1 ]"

# ── THE MINER IS A BINARY, AND NOTHING REBUILT IT (#412) ─────────────────────────────
#
# install-ops syncs scripts and units; it cannot rebuild a binary. So a commit touching
# miner source left the installed binary older than its sources, box-report reported
# `minerBinary: stale`, the box sat at 40 of 41, and live-smoke went red until a human
# ran two commands from MINING.md.
#
# Not theoretical: #402 merged 2026-08-04 17:32 UTC and the next probe run went red and
# stayed red for two days. These assert the routing and the failure paths; a real cargo
# build is out of scope for a shell suite, so MINER_CARGO injects a stub.

echo "== auto-deploy: a commit touching miner source triggers a rebuild"
ad_env
CARGO_STUB="$T/cargo-ok"
cat > "$CARGO_STUB" <<'STUB'
#!/usr/bin/env bash
echo "cargo $*" >> "${CARGO_LOG:?}"
# Real cargo writes the binary where --manifest-path says. Mirror that, or the install
# step below has nothing to move and the test would pass on an empty rebuild.
mp=""; for a in "$@"; do case "$prev" in --manifest-path) mp="$a";; esac; prev="$a"; done
out="$(dirname "$mp")/target/release"
mkdir -p "$out"; printf 'built %s\n' "$RANDOM" > "$out/zcash-testnet-miner"
STUB
chmod +x "$CARGO_STUB"
export CARGO_LOG="$T/cargo.calls"; : > "$CARGO_LOG"
echo active > "$STUB_SYSTEMD/zcash-testnet-miner.service"
ad_advance deploy/z3/miner/src/main.rs
MINER_CARGO="$CARGO_STUB" bash "$AD" > "$T/miner.log" 2>&1
check "a miner-source commit exits 0" "[ $? -eq 0 ]"
check "cargo was invoked" "grep -q 'cargo build --release' '$CARGO_LOG'"
check "and it built the repo's manifest, not whatever was in cwd" \
  "grep -q -- '--manifest-path' '$CARGO_LOG'"
check "the binary landed in the install dir" "[ -f '$T/install/zcash-testnet-miner' ]"
check "and the run says so, with the hash, so the log is evidence" \
  "grep -qE 'miner rebuilt and restarted \(' '$T/miner.log'"
check "no temp file was left behind" "[ ! -e '$T/install/.zcash-testnet-miner.new' ]"
check "a RUNNING miner was restarted onto the new binary" "grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"

echo "== auto-deploy: a restart that FAILS is a failed run, not a success line over an old process"
# Review: the success line was unconditional and the exit code stayed 0, so the journal
# read ERROR then "rebuilt and restarted", nobody was paged (Type=oneshot, OnFailure only on
# a non-zero exit), and box-report's mtime check called the binary fresh while the running
# process was the old build.
ad_env
export CARGO_LOG="$T/cargo.calls"; : > "$CARGO_LOG"
echo active > "$STUB_SYSTEMD/zcash-testnet-miner.service"
ad_advance deploy/z3/miner/src/main.rs
MINER_CARGO="$CARGO_STUB" STUB_RESTART_FAIL=1 bash "$AD" > "$T/restartfail.log" 2>&1
check "a failed restart exits NONZERO, so OnFailure pages" "[ $? -ne 0 ]"
check "and says the running process is the old build" "grep -q 'restart failed, so the running process is still the old build' '$T/restartfail.log'"
check "and does NOT also claim a restart" "! grep -q 'rebuilt and restarted' '$T/restartfail.log'"

echo "== auto-deploy: a CRASH-LOOPING miner (activating) is left to systemd and not called stopped"
# The unit has Restart=always, so a miner that dies on start alternates activating and a
# brief run; the 2-minute timer samples that window. Its next exec is the new binary.
ad_env
export CARGO_LOG="$T/cargo.calls"; : > "$CARGO_LOG"
echo activating > "$STUB_SYSTEMD/zcash-testnet-miner.service"
ad_advance deploy/z3/miner/src/main.rs
MINER_CARGO="$CARGO_STUB" bash "$AD" > "$T/activating.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "no restart" "! grep -q 'systemctl restart' '$STUB_LOG'"
check "and the log names the state it saw, not a park nobody made" "grep -q 'the unit is activating and is left to systemd' '$T/activating.log' && ! grep -q 'left stopped' '$T/activating.log'"

echo "== auto-deploy: a systemctl that cannot answer is an ERROR, not a quiet 'left stopped'"
# Mutating the stub to error on is-active made the running case take the stopped branch
# and exit 0 (review). The word is read; no word is unknown, and unknown is a failed run.
ad_env
export CARGO_LOG="$T/cargo.calls"; : > "$CARGO_LOG"
# rm FIRST: $T/bin/systemctl is a symlink into the shared stubs dir, and writing through
# it replaced the real stub for every later case and suite (46 failures, once).
rm -f "$T/bin/systemctl"
printf '#!/usr/bin/env bash\necho "Failed to connect to bus" >&2; exit 1\n' > "$T/bin/systemctl"; chmod +x "$T/bin/systemctl"
ad_advance deploy/z3/miner/src/main.rs
MINER_CARGO="$CARGO_STUB" bash "$AD" > "$T/nobus.log" 2>&1
check "exits NONZERO" "[ $? -ne 0 ]"
check "and says systemctl could not say" "grep -q 'systemctl could not say what state' '$T/nobus.log'"
check "and the binary was still installed, so the next start runs it" "[ -f '$T/install/zcash-testnet-miner' ]"

echo "== auto-deploy: a rebuild does NOT start a miner someone STOPPED"
# 2026-09-08 the owner parked the miner. 2026-09-09 00:58 the deploy of the next miner
# commit rebuilt it and ran `systemctl restart`, which starts a stopped unit, and it mined
# in Submit mode for hours against a decision nobody had reversed. The binary is still
# installed, so the next start runs it; the deploy simply does not decide who mines.
ad_env
export CARGO_LOG="$T/cargo.calls"; : > "$CARGO_LOG"
echo inactive > "$STUB_SYSTEMD/zcash-testnet-miner.service"
ad_advance deploy/z3/miner/src/main.rs
MINER_CARGO="$CARGO_STUB" bash "$AD" > "$T/parked.log" 2>&1
check "a miner-source commit against a stopped miner still exits 0" "[ $? -eq 0 ]"
check "the binary was rebuilt and installed" "grep -q 'cargo build' '$CARGO_LOG' && [ -f '$T/install/zcash-testnet-miner' ]"
check "but the stopped unit was NOT restarted" "! grep -q 'systemctl restart' '$STUB_LOG'"
check "and it is still stopped afterwards" "[ \"\$(cat '$STUB_SYSTEMD/zcash-testnet-miner.service')\" = inactive ]"
check "and the log says so, with the hash, rather than claiming a restart" \
  "grep -qE 'left stopped as it was found.*\(' '$T/parked.log' && ! grep -q 'rebuilt and restarted' '$T/parked.log'"

echo "== auto-deploy: a commit NOT touching miner source does not rebuild it"
# The mirror. Without it the check above would pass against a script that rebuilt on
# every commit, which would restart the miner - a money path - on unrelated deploys.
ad_env
export CARGO_LOG="$T/cargo.calls"; : > "$CARGO_LOG"
ad_advance src/page.tsx
MINER_CARGO="$CARGO_STUB" bash "$AD" > "$T/nominer.log" 2>&1
check "an app-only commit exits 0" "[ $? -eq 0 ]"
check "cargo was NOT invoked" "[ ! -s '$CARGO_LOG' ]"

echo "== auto-deploy: A FAILED MINER BUILD FAILS THE RUN"
# The rule this file already states for installs: reporting success for a box that is
# not at spec is how the missing 19 files stayed invisible. shellcheck caught that the
# exit code was set and never read, which would have made this path decorative.
ad_env
FAIL_STUB="$T/cargo-fail"
printf '#!/usr/bin/env bash\nexit 101\n' > "$FAIL_STUB"; chmod +x "$FAIL_STUB"
ad_advance deploy/z3/miner/src/main.rs
MINER_CARGO="$FAIL_STUB" bash "$AD" > "$T/minerfail.log" 2>&1
check "a failed build exits NONZERO" "[ $? -ne 0 ]"
check "and says the old binary was kept rather than implying a swap" \
  "grep -q 'keeping the binary that is already installed' '$T/minerfail.log'"
check "and nothing was installed" "[ ! -f '$T/install/zcash-testnet-miner' ]"

echo "== auto-deploy: no cargo at all is an error, not a silent skip"
# Found the hard way: cargo is not on a non-login shell's PATH on the box, so the first
# rebuild I ran by hand compiled nothing and reported success.
ad_env
ad_advance deploy/z3/miner/Cargo.lock
MINER_CARGO="$T/no-such-cargo" bash "$AD" > "$T/nocargo.log" 2>&1
check "a missing cargo exits NONZERO" "[ $? -ne 0 ]"
check "and names the path it looked for" "grep -q 'no cargo at' '$T/nocargo.log'"

# ── THE SWALLOWED COMMIT: redeploy's own pull advanced HEAD past the tick (#416's alert.sh) ──
#
# Observed on prod 2026-08-07. One tick processed commit A and ran install-ops for it;
# redeploy then pulled to B before building, so the image was B's but B's ops files were
# never installed. The next tick compared HEAD (already B) to origin and said "nothing to
# do". alert.sh sat stale on the box while every deploy log read success; only the box
# report noticed. The baseline is now a state file recording what THIS SCRIPT processed,
# not wherever redeploy left the checkout.

echo "== auto-deploy: a commit swallowed by redeploy's pull is processed next tick"
ad_env
export AUTODEPLOY_STATE_FILE="$T/last-processed"
# Tick 1 processes A cleanly, recording it.
ad_advance deploy/z3/watchdog.sh
bash "$AD" > "$T/tick1.log" 2>&1
check "tick 1 exits 0" "[ $? -eq 0 ]"
check "and records what it processed" "[ -s '$T/last-processed' ]"
# Now main gains B (ops-touching), and the CHECKOUT is already at B, exactly as
# redeploy's pull leaves it. Under HEAD-based detection this is "nothing to do".
ad_advance deploy/z3/alert.sh
git -C "$T/repo" fetch -q origin main
git -C "$T/repo" reset -q --hard origin/main
: > "$INSTALLOPS_LOG"
bash "$AD" > "$T/tick2.log" 2>&1
check "tick 2 exits 0" "[ $? -eq 0 ]"
check "AND STILL RUNS INSTALL-OPS, despite HEAD already sitting at B" "[ -s '$INSTALLOPS_LOG' ]"
check "then records B, so tick 3 is a real no-op" \
  "bash '$AD' > '$T/tick3.log' 2>&1 && grep -q 'nothing to do' '$T/tick3.log'"

echo "== auto-deploy: a FAILED tick does not advance the baseline, so the work is retried"
ad_env
export AUTODEPLOY_STATE_FILE="$T/last-processed"
ad_advance deploy/z3/watchdog.sh
bash "$AD" > /dev/null 2>&1
before="$(cat "$T/last-processed")"
ad_advance deploy/z3/alert.sh
STUB_INSTALLOPS_RC=1 bash "$AD" > "$T/fail.log" 2>&1
check "the failing tick exits nonzero" "[ $? -ne 0 ]"
check "and the baseline did NOT move, so next tick retries the same commits" \
  "[ \"\$(cat '$T/last-processed')\" = '$before' ]"

echo "== auto-deploy: a state file pointing at an unknown commit falls back to HEAD"
# A force push or a box restored from backup. Refusing to deploy over bookkeeping would
# be worse than the race this file exists to close.
ad_env
export AUTODEPLOY_STATE_FILE="$T/last-processed"
echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" > "$T/last-processed"
ad_advance src/page.tsx
bash "$AD" > "$T/unknown.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "says it fell back rather than doing it silently" "grep -q 'falling back to HEAD' '$T/unknown.log'"

# ── THE EXIT-2 AMPLIFIER (risk register #13) ─────────────────────────────────────────────
# redeploy's 2 means shipped and healthy but unverified against the commit. It took the
# same early exit as 1, so the baseline never advanced and every tick rebuilt, recreated
# and paged for as long as the manifest check was down. And a commit that genuinely
# fails every time was retried, rebuilt and paged every two minutes, forever.

echo "== auto-deploy: redeploy exit 3 (SHIPPED, unverified) pages once and ADVANCES the baseline"
# redeploy spends 3 on a live, healthy build nobody could compare to the commit. The first
# version of this read redeploy's 2 as that, and 2 also covers a build that does not
# compile: it would have recorded an unshipped commit as processed (review).
ad_env
export AUTODEPLOY_STATE_FILE="$T/last-processed"
ad_advance deploy/z3/watchdog.sh
bash "$AD" > /dev/null 2>&1
ad_advance src/page.tsx
# Two failures first, so the record exists and the shipped tick has something to clear.
STUB_REDEPLOY_RC=1 bash "$AD" > /dev/null 2>&1
STUB_REDEPLOY_RC=1 bash "$AD" > /dev/null 2>&1
check "precondition: a failure record exists" "[ -s '$T/last-processed.failures' ]"
: > "$REDEPLOY_LOG"
STUB_REDEPLOY_RC=3 bash "$AD" > "$T/unverified.log" 2>&1
check "the tick exits 3, so the unit pages" "[ $? -eq 3 ]"
check "and says it shipped, recorded the commit, and will page once" "grep -q 'shipped but UNVERIFIED: recorded' '$T/unverified.log'"
check "the baseline ADVANCED to the shipped commit" "[ \"\$(cat '$T/last-processed')\" = \"\$(git -C '$T/repo' rev-parse origin/main)\" ]"
check "and the failure record is cleared" "[ ! -e '$T/last-processed.failures' ]"
: > "$REDEPLOY_LOG"
STUB_REDEPLOY_RC=3 bash "$AD" > "$T/unverified2.log" 2>&1
check "the next tick is a no-op: exit 0" "[ $? -eq 0 ]"
check "that ran no redeploy" "[ ! -s '$REDEPLOY_LOG' ]"
check "and said nothing to do" "grep -q 'nothing to do' '$T/unverified2.log'"

echo "== auto-deploy: redeploy exit 2 (did NOT ship) is a failure to retry, never recorded as processed"
ad_env
export AUTODEPLOY_STATE_FILE="$T/last-processed"
ad_advance deploy/z3/watchdog.sh
bash "$AD" > /dev/null 2>&1
before="$(cat "$T/last-processed")"
ad_advance src/page.tsx
STUB_REDEPLOY_RC=2 bash "$AD" > "$T/notshipped.log" 2>&1
check "exits 2, redeploy's code" "[ $? -eq 2 ]"
check "the baseline did NOT move" "[ \"\$(cat '$T/last-processed')\" = '$before' ]"
check "and it counted as a failure" "grep -q ' 1 ' '$T/last-processed.failures'"
check "and never claimed to have shipped" "! grep -q 'shipped but UNVERIFIED' '$T/notshipped.log'"

echo "== auto-deploy: app shipped (3) but ops FAILED is a failure of the box, exit 1, not recorded"
ad_env
export AUTODEPLOY_STATE_FILE="$T/last-processed"
ad_advance deploy/z3/watchdog.sh
bash "$AD" > /dev/null 2>&1
before="$(cat "$T/last-processed")"
ad_advance src/page.tsx deploy/z3/alert.sh
STUB_INSTALLOPS_RC=1 STUB_REDEPLOY_RC=3 bash "$AD" > "$T/mixed.log" 2>&1
check "exits 1: the ops half's failure is not masked by the app half's softer code" "[ $? -eq 1 ]"
check "the baseline did NOT move" "[ \"\$(cat '$T/last-processed')\" = '$before' ]"
check "it counted as a failure, so it can back off" "grep -q ' 1 ' '$T/last-processed.failures'"
check "and the log says which half failed" "grep -q 'ops or miner half failed' '$T/mixed.log'"

echo "== auto-deploy: a failed install of install-ops.sh itself counts, so it can back off too"
# A read-only install dir. Mode bits do not bind root, so as root the dir is replaced by
# a FILE of the same name, which install cannot write into either.
ad_env
export AUTODEPLOY_STATE_FILE="$T/last-processed" AUTODEPLOY_BACKOFF_AFTER=2
ad_advance deploy/z3/watchdog.sh
bash "$AD" > /dev/null 2>&1
ad_advance deploy/z3/alert.sh
if [ "$(id -u)" = "0" ]; then rm -rf "$T/install"; : > "$T/install"; else chmod 555 "$T/install"; fi
bash "$AD" > /dev/null 2>&1
bash "$AD" > /dev/null 2>&1
bash "$AD" > "$T/installfail.log" 2>&1
rc_if=$?
if [ "$(id -u)" = "0" ]; then rm -f "$T/install"; mkdir -p "$T/install"; else chmod 755 "$T/install"; fi
check "the third tick backed off" "[ $rc_if -ne 0 ] && grep -q 'backing off' '$T/installfail.log'"
unset AUTODEPLOY_BACKOFF_AFTER

echo "== auto-deploy: redeploy exit 2 beside a FAILED ops half exits 1, not the can-wait-until-morning 2"
ad_env
export AUTODEPLOY_STATE_FILE="$T/last-processed"
ad_advance deploy/z3/watchdog.sh
bash "$AD" > /dev/null 2>&1
ad_advance src/page.tsx deploy/z3/alert.sh
STUB_INSTALLOPS_RC=1 STUB_REDEPLOY_RC=2 bash "$AD" > "$T/mixed2.log" 2>&1
check "exits 1" "[ $? -eq 1 ]"
check "and counted the failure" "grep -q ' 1 ' '$T/last-processed.failures'"

echo "== auto-deploy: redeploy exit 1 (NOT shipped) keeps the baseline, and a commit failing every time BACKS OFF"
ad_env
export AUTODEPLOY_STATE_FILE="$T/last-processed" AUTODEPLOY_BACKOFF_AFTER=3 AUTODEPLOY_BACKOFF_SECONDS=1800
ad_advance deploy/z3/watchdog.sh
bash "$AD" > /dev/null 2>&1
before="$(cat "$T/last-processed")"
ad_advance src/page.tsx
for i in 1 2 3; do
  : > "$REDEPLOY_LOG"
  STUB_REDEPLOY_RC=1 bash "$AD" > "$T/fail$i.log" 2>&1
  check "failure $i exits 1 and pages" "[ $? -eq 1 ]"
  check "failure $i ran redeploy (a real retry)" "[ -s '$REDEPLOY_LOG' ]"
done
check "the baseline did NOT move" "[ \"\$(cat '$T/last-processed')\" = '$before' ]"
check "the failure record names the commit and the count" "grep -q \"^\$(git -C '$T/repo' rev-parse origin/main) 3 \" '$T/last-processed.failures'"
: > "$REDEPLOY_LOG"
STUB_REDEPLOY_RC=1 bash "$AD" > "$T/backoff.log" 2>&1
check "the fourth tick BACKS OFF, exiting non-zero so the unit stays red (the page is deduped hourly)" "[ $? -eq 1 ]"
check "no redeploy ran" "[ ! -s '$REDEPLOY_LOG' ]"
check "and the log says so, with the count and the wait" "grep -qE 'backing off: [0-9a-f]{7} has failed 3 times in a row, next retry in [0-9]+s' '$T/backoff.log'"
check "the wait is inside the window, never a nonsense number" "[ \"\$(grep -oE 'next retry in [0-9]+s' '$T/backoff.log' | grep -oE '[0-9]+')\" -le 1800 ]"
# A clock stepped BACKWARDS: the record's epoch is an hour in the future. Without the
# clamp the wait printed 5400s and the backoff outlived its window by the skew.
sha_now="$(git -C "$T/repo" rev-parse origin/main)"
printf '%s 3 %s\n' "$sha_now" "$(( $(date -u +%s) + 3600 ))" > "$T/last-processed.failures"
: > "$REDEPLOY_LOG"
STUB_REDEPLOY_RC=1 bash "$AD" > "$T/skew.log" 2>&1
check "with the record stamped in the future the tick still backs off" "[ $? -eq 1 ] && [ ! -s '$REDEPLOY_LOG' ]"
check "and prints a wait of exactly the window, not window plus skew" "grep -q 'next retry in 1800s' '$T/skew.log'"
# The window passes: the retry runs again.
: > "$REDEPLOY_LOG"
AUTODEPLOY_BACKOFF_SECONDS=0 STUB_REDEPLOY_RC=1 bash "$AD" > "$T/retry.log" 2>&1
check "after the window a retry runs and fails again" "[ $? -eq 1 ] && [ -s '$REDEPLOY_LOG' ]"
check "and the count went to 4" "grep -q ' 4 ' '$T/last-processed.failures'"
# A new commit resets the count: it is tried at once.
ad_advance src/page.tsx
: > "$REDEPLOY_LOG"
STUB_REDEPLOY_RC=0 bash "$AD" > "$T/fixed.log" 2>&1
check "a NEW commit is tried immediately, whatever the old one's count" "[ $? -eq 0 ] && [ -s '$REDEPLOY_LOG' ]"
check "a success clears the failure record" "[ ! -e '$T/last-processed.failures' ]"
check "and advances the baseline" "[ \"\$(cat '$T/last-processed')\" = \"\$(git -C '$T/repo' rev-parse origin/main)\" ]"

echo "== auto-deploy: an ops-only failure backs off the same way"
ad_env
export AUTODEPLOY_STATE_FILE="$T/last-processed" AUTODEPLOY_BACKOFF_AFTER=2
ad_advance deploy/z3/watchdog.sh
bash "$AD" > /dev/null 2>&1
ad_advance deploy/z3/alert.sh
STUB_INSTALLOPS_RC=1 bash "$AD" > /dev/null 2>&1
STUB_INSTALLOPS_RC=1 bash "$AD" > /dev/null 2>&1
: > "$INSTALLOPS_LOG"
STUB_INSTALLOPS_RC=1 bash "$AD" > "$T/opsbackoff.log" 2>&1
check "third tick backs off, non-zero" "[ $? -eq 1 ] && grep -q 'backing off' '$T/opsbackoff.log'"
check "and did not run install-ops" "[ ! -s '$INSTALLOPS_LOG' ]"
unset AUTODEPLOY_BACKOFF_AFTER AUTODEPLOY_BACKOFF_SECONDS
