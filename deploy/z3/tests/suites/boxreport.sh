# shellcheck shell=bash
# box-report.sh: what the box publishes about its own install state, which the external
# CI gate then fails on.
#
# It had no suite, and it shipped with a hole that nearly went into a public README as
# evidence: it counted *.sh and units, so it answered "28 of 28" while
# /opt/faucet/zcash-testnet-miner was a four-day-old build writing no heartbeat. The
# number was true about scripts and SILENT about the binary. A check that cannot fail
# about the thing it appears to cover is the same shape as FAUCET_MINER_ACTIVE, which
# also could not be false while the miner was broken.

BOX_REPORT="$REPO/deploy/z3/box-report.sh"

box_env() {
  mk_scratch "${TMPDIR:-/tmp}/boxreport-test.XXXXXX"
  export PATH="$SCRATCH/stubs:$BASE_PATH"
  mkdir -p "$T/repo/deploy/z3/miner/src" "$T/install" "$T/units" "$T/out"
  export BOX_REPORT_REPO="$T/repo"
  export BOX_REPORT_INSTALL_DIR="$T/install"
  export BOX_REPORT_UNIT_DIR="$T/units"
  export BOX_REPORT_OUT="$T/out/box-integrity.json"
  export BOX_REPORT_SYSTEMCTL="$SCRATCH/stubs/audit-systemctl"
  export STUB_ENABLED="$T/enabled"; : > "$STUB_ENABLED"
  S="$T/repo/deploy/z3"
  printf '#!/usr/bin/env bash\necho watchdog\n' > "$S/watchdog.sh"
  printf '[Unit]\nDescription=t\n[Timer]\nOnCalendar=hourly\n[Install]\nWantedBy=timers.target\n' \
    > "$S/faucet-thing.timer"
  printf 'fn main() {}\n' > "$S/miner/src/main.rs"
  # A box that matches: script installed, unit installed and enabled.
  cp "$S/watchdog.sh" "$T/install/watchdog.sh"
  cp "$S/faucet-thing.timer" "$T/units/faucet-thing.timer"
  printf 'faucet-thing.timer\n' > "$STUB_ENABLED"
}
jqf() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2" 2>/dev/null; }

echo "== box-report: a binary NEWER than its sources is current and counted"
box_env
touch -d '2026-01-01 00:00:00' "$S/miner/src/main.rs"
printf 'ELF-ish\n' > "$T/install/zcash-testnet-miner"
touch -d '2026-06-01 00:00:00' "$T/install/zcash-testnet-miner"
bash "$BOX_REPORT" > /dev/null 2>&1
check "the report is readable" "[ \"\$(jqf '$BOX_REPORT_OUT' readable)\" = 'True' ]"
check "the binary is reported CURRENT" "[ \"\$(jqf '$BOX_REPORT_OUT' minerBinary)\" = 'current' ]"
check "and it is counted in expected" "[ \"\$(jqf '$BOX_REPORT_OUT' expected)\" = '3' ]"
check "and counted in present, so a good box reads complete" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' present)\" = '3' ]"

echo "== box-report: THE HOLE. a binary OLDER than its sources is STALE, not present"
# Exactly the production state: a merged Rust change nobody compiled. Before this the
# count read 2 of 2 and the box looked perfect.
box_env
printf 'ELF-ish\n' > "$T/install/zcash-testnet-miner"
touch -d '2026-01-01 00:00:00' "$T/install/zcash-testnet-miner"
touch -d '2026-06-01 00:00:00' "$S/miner/src/main.rs"
bash "$BOX_REPORT" > /dev/null 2>&1
check "the binary is reported STALE" "[ \"\$(jqf '$BOX_REPORT_OUT' minerBinary)\" = 'stale' ]"
check "it is still EXPECTED, so the denominator does not shrink to hide it" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' expected)\" = '3' ]"
# The whole point: present must be short of expected, so the gate fails.
check "and NOT counted present, so the box does not read complete" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' present)\" = '2' ]"

echo "== box-report: a missing binary is ABSENT and also short of expected"
box_env
touch -d '2026-06-01 00:00:00' "$S/miner/src/main.rs"
bash "$BOX_REPORT" > /dev/null 2>&1
check "the binary is reported ABSENT" "[ \"\$(jqf '$BOX_REPORT_OUT' minerBinary)\" = 'absent' ]"
check "and the count is short" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' present)\" != \"\$(jqf '$BOX_REPORT_OUT' expected)\" ]"

echo "== box-report: no miner sources means the binary is UNTRACKED, not failing"
# A checkout without the miner must not report a permanent shortfall: a check that is
# always red is one people learn to ignore, which is how the real ones get missed.
box_env
rm -rf "$S/miner"
bash "$BOX_REPORT" > /dev/null 2>&1
check "the binary is reported UNTRACKED" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' minerBinary)\" = 'untracked' ]"
check "and it is NOT added to expected, so the box can still read complete" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' expected)\" = '2' ]"
check "and present equals expected on an otherwise good box" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' present)\" = '2' ]"

echo "== box-report: a stale SCRIPT is still not counted as present"
# The pre-existing promise, re-asserted because the binary work touches the same counters.
box_env
touch -d '2026-01-01 00:00:00' "$S/miner/src/main.rs"
printf 'ELF-ish\n' > "$T/install/zcash-testnet-miner"
echo "# edited on the box" >> "$T/install/watchdog.sh"
bash "$BOX_REPORT" > /dev/null 2>&1
check "a hand-edited script is not present" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' present)\" != \"\$(jqf '$BOX_REPORT_OUT' expected)\" ]"

echo "== box-report: an installed-but-disabled unit is reported, not counted as fine"
box_env
touch -d '2026-01-01 00:00:00' "$S/miner/src/main.rs"
printf 'ELF-ish\n' > "$T/install/zcash-testnet-miner"
: > "$STUB_ENABLED"
bash "$BOX_REPORT" > /dev/null 2>&1
check "notEnabled counts the disabled unit" "[ \"\$(jqf '$BOX_REPORT_OUT' notEnabled)\" = '1' ]"

echo "== box-report: an empty source tree says cannot-say rather than perfect"
# 0 of 0 reported as complete is the false pass this script exists to prevent.
box_env
rm -f "$S"/*.sh "$S"/*.timer
rm -rf "$S/miner"
bash "$BOX_REPORT" > /dev/null 2>&1
check "readable is false when there was nothing to compare" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' readable)\" = 'False' ]"

echo "== box-report: a source in a SUBDIRECTORY still makes the binary stale"
# My first version globbed $MINER_SRC_DIR/*.rs, top level only. The day someone adds
# src/anything/mod.rs, a stale binary would have read `current`: the same false pass this
# check exists to remove, hiding inside the check.
box_env
mkdir -p "$S/miner/src/inner"
touch -d '2026-01-01 00:00:00' "$S/miner/src/main.rs"
printf 'ELF-ish\n' > "$T/install/zcash-testnet-miner"
touch -d '2026-03-01 00:00:00' "$T/install/zcash-testnet-miner"
printf 'pub fn x() {}\n' > "$S/miner/src/inner/mod.rs"
touch -d '2026-06-01 00:00:00' "$S/miner/src/inner/mod.rs"
bash "$BOX_REPORT" > /dev/null 2>&1
check "a nested source newer than the binary is STALE" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' minerBinary)\" = 'stale' ]"

echo "== box-report: a dependency bump with no .rs change also makes it stale"
# Cargo.lock moving changes the binary. Watching only sources would call this current.
box_env
touch -d '2026-01-01 00:00:00' "$S/miner/src/main.rs"
printf 'ELF-ish\n' > "$T/install/zcash-testnet-miner"
touch -d '2026-03-01 00:00:00' "$T/install/zcash-testnet-miner"
printf '[[package]]\nname = "x"\n' > "$S/miner/Cargo.lock"
touch -d '2026-06-01 00:00:00' "$S/miner/Cargo.lock"
bash "$BOX_REPORT" > /dev/null 2>&1
check "a newer Cargo.lock makes the binary STALE" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' minerBinary)\" = 'stale' ]"

echo "== box-report: the production shape, a binary built AFTER its sources, reads current"
# The CTO measured the box: binary 83 minutes newer than its newest source. If my check
# called that stale it would be a defect in the check, not an honest short count.
box_env
touch -d '2026-07-31 12:19:00' "$S/miner/src/main.rs"
printf 'ELF-ish\n' > "$T/install/zcash-testnet-miner"
touch -d '2026-07-31 13:42:00' "$T/install/zcash-testnet-miner"
bash "$BOX_REPORT" > /dev/null 2>&1
check "83 minutes newer than its newest source reads CURRENT" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' minerBinary)\" = 'current' ]"
check "and the box reads complete, present equals expected" \
  "[ \"\$(jqf '$BOX_REPORT_OUT' present)\" = \"\$(jqf '$BOX_REPORT_OUT' expected)\" ]"

echo "== box-report: A FRESH CLONE MUST NOT FORCE stale, which is how a false finding was made"
# The CTO dry-ran #301 from a fresh shallow clone and got "28 of 29, minerBinary stale". It
# was an artifact of the instrument: git sets working-tree mtimes to CHECKOUT time, so every
# source is newer than any binary and an older-than-sources test cannot return anything else.
# The clone decided the answer before the check ran, and a CI job that clones fresh would
# report stale forever while looking like a real finding.
#
# Our false-pass doctrine pointed the other way: a check that FAILS for a reason unrelated to
# the thing under test.
box_env
# The commit is BACKDATED, because that is the real situation: the last change to the miner
# happened at 12:19, the binary was built at 13:42, and then a fresh clone stamped every
# working-tree mtime with the checkout time. Committing "now" would have made the sources
# genuinely newer than the binary, and the test would then have passed for the wrong reason
# or failed for a real one. My first version of this fixture did exactly that.
( cd "$T/repo" && git init -q . && git config user.email t@t && git config user.name t \
  && git add -A \
  && GIT_AUTHOR_DATE='2026-07-31T12:19:00' GIT_COMMITTER_DATE='2026-07-31T12:19:00' \
     git commit -qm "miner sources" ) >/dev/null 2>&1
# Built AFTER that commit, which is the truth we want reported...
printf 'ELF-ish\n' > "$T/install/zcash-testnet-miner"
touch -d '2026-07-31 13:42:00' "$T/install/zcash-testnet-miner"
# ...but every source mtime is NOW, as a checkout leaves them, so mtime ALONE says stale.
touch "$S/miner/src/main.rs"
bash "$BOX_REPORT" > /dev/null 2>&1
if command -v git >/dev/null 2>&1; then
  check "a checkout whose mtimes are all fresh does NOT read stale" \
    "[ \"\$(jqf '$BOX_REPORT_OUT' minerBinary)\" != 'stale' ]"
  # And it reaches the RIGHT answer, not merely a different wrong one: the binary really is
  # newer than the last committed change, so current is the truth here.
  check "it reads CURRENT, because git's answer survives the clone" \
    "[ \"\$(jqf '$BOX_REPORT_OUT' minerBinary)\" = 'current' ]"
else
  echo "  (skipped: no git in this environment, so the git basis cannot be exercised)"
fi

echo "== box-report: uncommitted miner changes are UNKNOWN, never stale"
# We cannot know what the binary was built from, and accusing it on evidence we do not have
# is the same error as excusing it.
box_env
( cd "$T/repo" && git init -q . && git config user.email t@t && git config user.name t \
  && git add -A && git commit -qm base ) >/dev/null 2>&1
printf 'ELF-ish\n' > "$T/install/zcash-testnet-miner"
printf 'fn main() { /* edited, not committed */ }\n' > "$S/miner/src/main.rs"
bash "$BOX_REPORT" > /dev/null 2>&1
if command -v git >/dev/null 2>&1; then
  check "a dirty miner tree reports UNKNOWN rather than stale" \
    "[ \"\$(jqf '$BOX_REPORT_OUT' minerBinary)\" = 'unknown' ]"
  check "and unknown is NOT counted present, so the gate still fails" \
    "[ \"\$(jqf '$BOX_REPORT_OUT' present)\" != \"\$(jqf '$BOX_REPORT_OUT' expected)\" ]"
else
  echo "  (skipped: no git in this environment)"
fi
