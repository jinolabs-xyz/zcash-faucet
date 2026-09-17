# shellcheck shell=bash
# zallet-rewind-report.sh: the detector for the outage nothing we run can see.
#
# THE FIXTURE IS THE 2026-09-16 INCIDENT, not an invention. Those minutes, counts and heights
# are the owner's own per-minute read of the container log for 02:15Z-02:45Z: 20 scans at the
# tip at 02:28, then 52 starting 998 blocks lower at 02:29, climbing back through 02:39 and
# reaching the tip at 02:41. A parser held against made-up input proves the parser matches my
# idea of the log, which is the thing most likely to be wrong.
#
# AND THE LOG IS ANSI-COLOURED, which is not a detail. zallet colours its timestamps, so the
# first field of a raw line is not a time and every field offset after it is wrong. A grep that
# comes back empty against a coloured log reports as a QUIET WINDOW - a clean answer about
# nothing - so the fixtures carry the escape sequences and one case is about exactly that.

RW="$REPO/deploy/z3/zallet-rewind-report.sh"

zw_env() {
  mk_scratch "${TMPDIR:-/tmp}/zalletrewind.XXXXXX"
  mkdir -p "$T/bin"
  export STUB_LOG="$T/docker.calls"; : > "$STUB_LOG"
  export STUB_LOGFILE="$T/zallet.log"; : > "$STUB_LOGFILE"
  rm -f "$T/bin/docker"
  cat > "$T/bin/docker" <<'D'
#!/usr/bin/env bash
printf '%s\n' "docker $*" >> "${STUB_LOG:?}"
case "$1" in
  logs) cat "${STUB_LOGFILE:?}"; exit 0 ;;
esac
exit 0
D
  chmod +x "$T/bin/docker"
  export PATH="$T/bin:$PATH"
}

# Append scan lines for one minute: $1=HH:MM, $2=count, $3=first height, $4=last height.
#
# FIRST AND LAST ARE GIVEN SEPARATELY BECAUSE THE REAL LOG DOES NOT ASCEND BY ONE PER LINE. The
# owner's 02:28 is 20 scan lines spanning heights 4353351 to 4353366 - sixteen heights, twenty
# lines - and a fixture that stepped by one would put the last height at 4353370 and the rewind
# depth at 1002 instead of 998. My first draft did exactly that and the depth row caught it,
# which is the fixture earning its place: the detector reads first and last, so those are what
# the fixture has to get right.
# COLOURED, because the real ones are: \033[2m on the timestamp is what zallet emits.
zw_minute() {
  local hm="$1" count="$2" first="$3" last="${4:-}" i=0 h
  [ -n "$last" ] || last=$((first + count - 1))
  while [ "$i" -lt "$count" ]; do
    h=$((first + i))
    [ "$h" -gt "$last" ] && h="$last"
    printf '\033[2m2026-09-16T%s:%02dZ\033[0m \033[32m INFO\033[0m zallet::sync: Scanning block %s\n' \
      "$hm" "$((i % 60))" "$h" >> "$STUB_LOGFILE"
    i=$((i + 1))
  done
}

zw_run() { set +e; OUT="$(bash "$RW" "$@" 2>&1)"; RC=$?; set -e; printf '%s\n' "$OUT" > "$T/last.out"; }

echo "== rewind report: the 2026-09-16 rewind is found, with its depth"
zw_env
zw_minute "02:28" 20 4353351 4353366   # at the tip
zw_minute "02:29" 52 4352368 4352419   # 998 blocks below 4353366: the rewind
zw_minute "02:30" 77 4352420 4352496
zw_run --container z3-testnet-zallet-1
check "it reports a rewind at the minute it happened" \
  "[ $RC -eq 0 ] && grep -q '02:29' '$T/last.out' && grep -q 'REWIND' '$T/last.out'"
check "and names the depth, which is the number that says whether it was a reorg or a config" \
  "grep -q 'REWIND of 998 blocks' '$T/last.out'"
check "and counts exactly one, not one per re-scanning minute" \
  "grep -q '^1 rewind(s) in this window' '$T/last.out'"
# ANTI-VACUITY: the rows above are all satisfied by a run that read nothing and printed nothing.
check "and it actually read the scan lines rather than reporting on an empty log" \
  "grep -q '149 scan lines' '$T/last.out'"

echo "== rewind report: a COLOURED log is read, because the real one is coloured"
# The fixtures carry \033[2m on the timestamp. Without the strip, $1 is an escape sequence, the
# minute is garbage and the height is read from the wrong field - and the failure is SILENT.
zw_env
zw_minute "02:28" 20 4353351 4353366
zw_minute "02:29" 52 4352368 4352419
zw_run
check "the minute is a real minute and not an escape sequence" \
  "grep -qE '^02:29 ' '$T/last.out' || grep -q ' 02:29 ' '$T/last.out'"
check "and the heights are the heights" "grep -q '4352368' '$T/last.out'"

echo "== rewind report: a quiet window is NOT the same answer as no window"
# The failure that reads like good news. An empty log and a wallet that simply scanned nothing
# both produce zero scan lines, and calling both "0 rewinds" is how a broken query reports health.
zw_env
: > "$STUB_LOGFILE"
zw_run
check "an empty log REFUSES rather than reporting zero rewinds" \
  "[ $RC -eq 1 ] && grep -q 'NO LOG in this window' '$T/last.out'"
check "and says plainly that nothing was read" "grep -q 'nothing was read' '$T/last.out'"
zw_env
printf '\033[2m2026-09-16T02:28:01Z\033[0m INFO zallet: Reached chain tip, streaming mempool\n' > "$STUB_LOGFILE"
zw_run
check "a log with no scan lines but other traffic says so, and exits 0" \
  "[ $RC -eq 0 ] && grep -q 'scanned nothing here' '$T/last.out'"

echo "== rewind report: a window with no rewind says the window may be too small"
# "0 rewinds in 30 minutes" invites the conclusion that the trigger is gone. It is not evidence
# of that, and #602 is about a thing seen twice in one half hour.
zw_env
zw_minute "02:28" 6 4353351
zw_minute "02:29" 6 4353357
zw_minute "02:30" 6 4353363
zw_run
check "a clean window exits 0, because 'none' is an answer and not a broken command" "[ $RC -eq 0 ]"
check "and reports no rewinds" "grep -q '^0 rewind(s) in this window' '$T/last.out'"
check "and refuses to let that read as 'the trigger is gone'" \
  "grep -q 'not proof the trigger is gone' '$T/last.out'"

echo "== rewind report: the small rewind in the same window is found too"
# 02:20-02:22 of the incident: one block scanned, a quiet minute, then a restart three blocks
# lower. Three blocks is not 998, and a detector that only finds the dramatic one is no use for
# counting how often this happens - which is the whole of step 2.
zw_env
zw_minute "02:20" 1 4353182 4353182
zw_minute "02:22" 3 4353179 4353181
zw_minute "02:23" 66 4353183 4353248
zw_run
check "a 3-block rewind is reported, not only the thousand-block one" \
  "grep -q 'REWIND of 3 blocks' '$T/last.out'"

echo "== rewind report: it reads the log and does nothing else"
zw_env
zw_minute "02:29" 5 4352368
zw_run --since 2026-09-16T02:15:00Z --until 2026-09-16T02:45:00Z
check "the only docker verb it used is logs" \
  "[ \"\$(grep -c 'docker logs' '$STUB_LOG')\" = 1 ] && [ \"\$(grep -vc 'docker logs' '$STUB_LOG')\" = 0 ]"
check "and it passed the window through rather than silently reading the default" \
  "grep -q -- '--since 2026-09-16T02:15:00Z' '$STUB_LOG' && grep -q -- '--until 2026-09-16T02:45:00Z' '$STUB_LOG'"
check "and it says so to whoever is reading the paste" \
  "grep -q 'Nothing was stopped, opened or written' '$T/last.out'"

echo "== rewind report: an unknown flag is refused, not ignored"
zw_env
zw_minute "02:29" 5 4352368
zw_run --sinc 2026-09-16T02:15:00Z
check "a mistyped flag exits 64 with a usage line rather than reading the default window" \
  "[ $RC -eq 64 ] && grep -q 'usage:' '$T/last.out'"

echo "== rewind report: a log whose shape has moved is a refusal, not a clean window"
# The detector is positional: the height is the last field, the minute comes from an RFC3339
# first field. If zallet's format moves, the honest output is "I cannot read this" - the
# alternative is a confident zero.
zw_env
printf 'Scanning block\nScanning block\n' > "$STUB_LOGFILE"
zw_run
check "scan lines it cannot parse refuse rather than report zero rewinds" \
  "[ $RC -eq 1 ] && grep -q 'could not read a height or a timestamp' '$T/last.out'"
check "and it names what it expected, so the fix is obvious" \
  "grep -q 'last field' '$T/last.out' && grep -q 'RFC3339' '$T/last.out'"
