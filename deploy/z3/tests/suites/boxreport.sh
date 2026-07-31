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
