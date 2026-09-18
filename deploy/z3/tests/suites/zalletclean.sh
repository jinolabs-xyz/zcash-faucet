# shellcheck shell=bash
# zallet-abandon-expired-txs.sh and zallet-drop-unfetchable-queue.sh: the two cleanup tools
# from the August outages. Until now NEITHER WAS EXECUTED BY ANY SUITE. watchdog.sh stubs
# both - it replaces them with fakes to test the rung that calls them - so the calling was
# covered and the scripts themselves never ran once in CI. One of them deletes rows that
# cascade into sent_notes and received notes; its own header says so in capitals.
#
# WHAT THIS SUITE IS ABOUT, and it is deliberately not "does the repair work". The repair
# needs a real sqlite wallet, a real zebra and a stopped container, and a double that
# faked all three would be asserting against my own fiction. What it holds is the part
# that decides WHETHER THE DESTRUCTIVE PATH RUNS AT ALL: argument parsing, the running
# check, and #601's --read-only snapshot. Those are reachable with a docker double and
# they are where a mistake costs money rather than an afternoon.
#
# THE DOCKER DOUBLE RUNS THE SNAPSHOT FOR REAL. For the copy step it rewrites /d and /snap
# to the fixture directories and executes the script the tool passed, so "the -wal came
# with it" is read off files on disk rather than off a string in a log. Every other docker
# call is answered from fixtures and recorded.

ABANDON="$REPO/deploy/z3/zallet-abandon-expired-txs.sh"
DROPQ="$REPO/deploy/z3/zallet-drop-unfetchable-queue.sh"

zc_env() {
  mk_scratch "${TMPDIR:-/tmp}/zalletclean.XXXXXX"
  mkdir -p "$T/bin" "$T/vol"
  export STUB_LOG="$T/docker.calls"; : > "$STUB_LOG"
  # The fixture "volume": a wallet mid-write, which is the state --read-only is for. The
  # -wal carries commits the .db does not, which is the whole reason it has to travel with it.
  printf 'SQLite format 3\0fixture-db\n' > "$T/vol/wallet.db"
  printf 'wal-frames-not-yet-checkpointed\n'  > "$T/vol/wallet.db-wal"
  printf 'shm\n'                              > "$T/vol/wallet.db-shm"
  export STUB_VOL_DIR="$T/vol" STUB_ZALLET_RUNNING=true STUB_SQL_OUT="" STUB_RPC_HAS_TX=0
  export STUB_SNAP_KEEP="$T/snap-taken"; rm -rf "$STUB_SNAP_KEEP"
  unset STUB_TOUCH_DURING_COPY
  export ZALLET_CONTAINER="zallet-under-test" ZEBRA_CONTAINER="zebra-under-test" ZALLET_VOLUME="fixture-volume"
  # THE DESTRUCTIVE PATH HAS TO BE REACHABLE OR THE SAFETY ROWS PIN NOTHING. The repair copies
  # the volume's real host path before deleting; with that path absent the script dies at the
  # backup and "no delete happened" is true for the wrong reason. Standing it up here is what
  # lets a mutant that removes --read-only's force of --dry-run actually reach the delete.
  # THE DESTRUCTIVE PATH IS NOW ACTUALLY REACHABLE. This used to mkdir under
  # /var/lib/docker/volumes and copy the fixture there, with `2>/dev/null || true` on both - and
  # that path is ROOT-OWNED while the harness runs as a normal user by design, so it silently did
  # nothing and the backup and delete were never once executed by a test. The comment said the
  # opposite. ZALLET_VOL_DATA points the tools at the fixture volume instead, which is the same
  # directory the snapshot rows already read.
  export ZALLET_VOL_DATA="$T/vol"
  rm -f "$T/bin/docker"
  cat > "$T/bin/docker" <<'D'
#!/usr/bin/env bash
printf '%s\n' "docker $*" >> "${STUB_LOG:?}"
case "$1" in
  inspect) echo "${STUB_ZALLET_RUNNING:-false}"; exit 0 ;;
  exec)    echo "cookie:fixture"; exit 0 ;;
esac
# `docker run …`. Find the mounts and the trailing `sh -c <script>` (or the sqlite form,
# which is `sh -c <script> _ <sql>`).
SNAP=""; SCRIPT=""
prev=""; seen_c=0
for a in "$@"; do
  if [ "$prev" = "-v" ]; then
    case "$a" in *:/snap) SNAP="${a%%:*}" ;; esac
  fi
  if [ "$seen_c" = "1" ]; then SCRIPT="$a"; seen_c=2; fi
  [ "$a" = "-c" ] && seen_c=1
  prev="$a"
done
if [ -n "$SNAP" ]; then
  # THE SNAPSHOT, RUN FOR REAL against the fixture dirs. The tool's own script decides what
  # is copied; this only rebinds the two paths it names.
  real_src="${STUB_VOL_DIR:?}"
  printf '%s' "$SCRIPT" | sed "s#/snap#$SNAP#g; s#/d/#$real_src/#g; s#\"/d/#\"$real_src/#g" > "$SNAP/.script"
  # A CHECKPOINT AT THE DANGEROUS MOMENT, injected deterministically rather than raced for: the
  # window this guards is between the db copy and the -wal copy, so the double inserts the write
  # exactly there. A background toucher would reproduce the same state some of the time, and a
  # case that only sometimes sets up its subject is worse than no case.
  if [ "${STUB_TOUCH_DURING_COPY:-0}" = "1" ]; then
    awk -v src="$real_src" '''{ print; if ($0 ~ /cp .*wallet\.db .*wallet\.db$/) { printf "printf x >> %s/wallet.db\n", src; printf "touch -t 203001010000 %s/wallet.db\n", src } }''' \
      "$SNAP/.script" > "$SNAP/.script.2" && mv "$SNAP/.script.2" "$SNAP/.script"
  fi
  bash "$SNAP/.script" || exit 1
  rm -f "$SNAP/.script"
  # KEEP WHAT WAS COPIED. The tool traps EXIT and removes its own snapshot, which is right and
  # means the suite would otherwise be inspecting a deleted directory - the four rows below
  # failed for exactly that reason first. This is a copy of the real filesystem state the
  # tool's own script produced, taken the instant it produced it.
  if [ -n "${STUB_SNAP_KEEP:-}" ]; then
    mkdir -p "$STUB_SNAP_KEEP"
    cp -a "$SNAP/." "$STUB_SNAP_KEEP/" 2>/dev/null || true
  fi
  exit 0
fi
# THE RPC DOUBLE, AND THE METHOD MATTERS. A single answer for every curl is how the first
# version of this double made the tool abort with "zebra is not answering getblockcount":
# getblockcount got handed a getrawtransaction error and the tool was right to refuse.
case "$*" in
  *getblockcount*)    echo '{"result":4350000,"error":null}'; exit 0 ;;
  *getrawtransaction*)
    if [ "${STUB_RPC_HAS_TX:-0}" = "1" ]; then echo '{"result":"deadbeef","error":null}'
    else echo '{"result":null,"error":{"code":-5,"message":"Transaction not found in mempool or best chain"}}'; fi
    exit 0 ;;
  *curl*) echo '{"result":null,"error":null}'; exit 0 ;;
esac
# Otherwise a sqlite query: the SQL is the last argument.
printf '%s' "${STUB_SQL_OUT:-}"
exit 0
D
  chmod +x "$T/bin/docker"
  # curl for the zebra RPC goes through `docker run …  curlimages/curl`, so it is covered by
  # the double above; nothing else on PATH is replaced.
  export PATH="$T/bin:$PATH"
}

zc_run() { # $1=script, rest=args. Captures stdout+stderr, returns the exit code in RC.
  local sc="$1"; shift
  set +e
  OUT="$(TMPDIR="$T" bash "$sc" "$@" 2>&1)"
  RC=$?
  set -e
  printf '%s\n' "$OUT" > "$T/last.out"
}

echo "== zallet cleanup: a running wallet is refused, and the refusal says what to do instead"
# The abort is right - sqlite and the wallet must not both hold wallet.db - but before #601 it
# was the ONLY thing it said, so the cheapest diagnostic step looked impossible rather than
# differently-priced.
zc_env
export STUB_ZALLET_RUNNING=true
zc_run "$ABANDON"
check "abandon refuses while zallet is running, exit 1" "[ $RC -eq 1 ]"
check "and it names --read-only, so the look does not read as impossible" \
  "grep -q -- '--read-only' '$T/last.out'"
zc_run "$DROPQ"
check "drop-queue refuses the same way" "[ $RC -eq 1 ]"
check "and points the same way out" "grep -q -- '--read-only' '$T/last.out'"

echo "== zallet cleanup: the BACKUP takes the -wal and -shm, or it is not an undo"
# THE RULE WAS WRITTEN FOR THE READ AND NOT APPLIED TO THE UNDO. The snapshot refuses a partial
# copy and explains why in a comment; the backup one function later took wallet.db alone. A db
# without its -wal is internally consistent and OLD, and a stale -wal beside a restored db reports
# as "disk I/O error" - so the file that exists to reverse a 138-row cascade could be missing the
# wallet's most recent commits. Both repair tools had it, and watchdog.sh runs BOTH unattended on
# the poison path, so the incomplete copy is taken while nobody is watching.
#
# Normally there is nothing to take - sqlite checkpoints on last close and this runs stopped - but
# the case these tools exist for is a CRASH-LOOPING wallet, which is where a clean close is least
# likely. Checked rather than assumed.
zc_env
export STUB_ZALLET_RUNNING=false STUB_SQL_OUT="7:AABBCC" STUB_RPC_HAS_TX=0
zc_run "$ABANDON"
# ANTI-VACUITY FIRST, exactly as the snapshot case does it: every sidecar row below is satisfied
# by a run that never reached the backup at all.
check "the repair reached the backup and wrote one" \
  "ls '$T/vol'/wallet.db.bak-abandon-* >/dev/null 2>&1"
check "and the -wal came with it, so the undo is the state the wallet was actually in" \
  "ls '$T/vol'/wallet.db.bak-abandon-*-wal >/dev/null 2>&1"
check "and the -shm too" "ls '$T/vol'/wallet.db.bak-abandon-*-shm >/dev/null 2>&1"
zc_env
export STUB_ZALLET_RUNNING=false STUB_SQL_OUT="7:AABBCC" STUB_RPC_HAS_TX=0
zc_run "$DROPQ"
check "drop-queue backs up the same way, since the watchdog runs it on the same path" \
  "ls '$T/vol'/wallet.db.bak-queuefix-*-wal >/dev/null 2>&1"

echo "== zallet cleanup: the way BACK is printed, and it removes the LIVE sidecars first"
# SDE-App's finding on the sidecar fix, and it is the same defect one layer out: after that change
# the MATERIALS for an undo are complete and the PROCEDURE is not. Nothing in any runbook mentions
# bak-abandon or bak-queuefix, so the restore is whatever an operator invents at 3am - and the
# obvious one is wrong in exactly the way this file warns about: copy the db back, leave the LIVE
# -wal, and sqlite replays a stale sidecar against a restored database. "disk I/O error". Eaten once
# already.
# THIS IS A TEXT ASSERTION AND THAT IS THE RIGHT KIND: the artefact under test IS the printed
# instruction. What it must not do is print a restore that omits the step nobody thinks of.
zc_env
export STUB_ZALLET_RUNNING=false STUB_SQL_OUT="7:AABBCC" STUB_RPC_HAS_TX=0
zc_run "$ABANDON"
check "the repair reached the backup, so the rows below are not reading an early exit" \
  "grep -q 'backup:' '$T/last.out'"
check "and it prints a way back at all" "grep -q 'to undo:' '$T/last.out'"
check "and the LIVE -wal and -shm are removed BEFORE the database is copied back" \
  "awk '/to undo:/{u=1} u&&/rm -f .*wallet[.]db-wal/&&!r{r=NR} u&&/cp -f .*wallet[.]db/&&!/wallet[.]db-/&&!c{c=NR} END{exit !(r&&c&&r<c)}' '$T/last.out'"
check "and it names the LIVE sidecars, not the backup's copies, for the removal" \
  "grep -q \"rm -f $T/vol/wallet.db-wal $T/vol/wallet.db-shm\" '$T/last.out'"
check "and the backup's own sidecars are copied back too, or the restore is the bug again" \
  "grep -q 'cp -f .*wallet.db.bak-abandon-.*-wal' '$T/last.out'"
zc_env
export STUB_ZALLET_RUNNING=false STUB_SQL_OUT="7:AABBCC" STUB_RPC_HAS_TX=0
zc_run "$DROPQ"
check "drop-queue prints the same way back, since the watchdog runs it on the same path" \
  "grep -q 'to undo:' '$T/last.out' && grep -q 'rm -f .*wallet.db-wal' '$T/last.out'"

echo "== zallet cleanup: a wallet with NO -wal still backs up, rather than refusing"
# The ordinary case after a clean stop. Refusing here would turn a safety check into an outage,
# which is the failure mode the --read-only work was done to remove.
zc_env
rm -f "$T/vol/wallet.db-wal" "$T/vol/wallet.db-shm"
export STUB_ZALLET_RUNNING=false STUB_SQL_OUT="7:AABBCC" STUB_RPC_HAS_TX=0
zc_run "$ABANDON"
check "a wallet with no sidecars is backed up and not refused" \
  "[ $RC -eq 0 ] && ls '$T/vol'/wallet.db.bak-abandon-* >/dev/null 2>&1"
check "and no phantom -wal is invented beside it" \
  "! ls '$T/vol'/wallet.db.bak-abandon-*-wal >/dev/null 2>&1"

echo "== zallet cleanup: A TYPO IN THE FLAG USED TO RUN THE REAL REPAIR"
# `[ "$1" = "--dry-run" ]` left DRY_RUN=0 for every other spelling, so `--readonly`,
# `--dryrun` or `-n` reached the delete path with the operator believing they had asked for a
# preview. That is the whole argument for parsing arguments.
zc_env
export STUB_ZALLET_RUNNING=false STUB_SQL_OUT=""
for bad_flag in --readonly --dryrun -n --DRY-RUN; do
  zc_run "$ABANDON" "$bad_flag"
  check "abandon refuses '$bad_flag' with a usage error rather than treating it as a repair" \
    "[ $RC -eq 64 ] && grep -q 'usage:' '$T/last.out'"
done
zc_run "$DROPQ" --readonly
check "drop-queue refuses an unknown flag too" "[ $RC -eq 64 ]"

echo "== zallet cleanup: --read-only looks at a RUNNING wallet without stopping it (#601)"
zc_env
# A CANDIDATE THE TOOL WOULD OTHERWISE DELETE. Without one the "no delete happened" rows below
# pass because there was nothing to delete, which is not the same fact at all - my first draft
# had exactly that and a mutant removing --read-only's force of --dry-run SURVIVED at 22/0.
# The row that names the candidate is what makes the two rows under it mean anything.
export STUB_ZALLET_RUNNING=true STUB_SQL_OUT="7:AABBCC" STUB_RPC_HAS_TX=0
zc_run "$ABANDON" --read-only
check "it does not refuse, which is the point: the wallet is up" "[ $RC -eq 0 ]"
check "and says it is reading a snapshot and changing nothing" \
  "grep -q 'snapshot of wallet.db' '$T/last.out' && grep -q 'not stopped' '$T/last.out'"
check "and it FOUND something to abandon, so the two rows below are not passing on an empty list" \
  "grep -q 'would be abandoned' '$T/last.out'"
check "and it never ran a delete: no repair can happen down this path" \
  "! grep -qi 'delete from' '$STUB_LOG'"
check "and it took no backup either, because nothing is being changed" \
  "! grep -q 'wallet.db.bak-abandon' '$T/last.out'"
check "and it hands over the exact command that WOULD carry it out, with the stop and start" \
  "grep -q 'docker stop zallet-under-test' '$T/last.out' && grep -q 'docker start zallet-under-test' '$T/last.out'"

echo "== zallet cleanup: the snapshot takes the -wal and -shm WITH the database"
# A live sqlite db keeps recent commits in -wal. Copy the .db alone and you get a file that is
# internally consistent and OLD - a state that may never have existed as a whole - and a stale
# -wal beside a fresh db reports as "disk I/O error", which has already cost this repo an
# afternoon. The double runs the tool's own copy script for real, so this is read off disk.
zc_env
export STUB_ZALLET_RUNNING=true
zc_run "$ABANDON" --read-only
# ANTI-VACUITY FIRST, and it is the one that matters here: every row below is satisfied by a
# snapshot directory that was never written at all. If the db itself is not there, the sidecar
# rows are reporting on an empty directory rather than on a copy.
check "a snapshot was taken and the database itself is in it" \
  "[ -s '$T/snap-taken/wallet.db' ]"
check "and the -wal came with it, so the snapshot is the state the wallet is actually in" \
  "[ -s '$T/snap-taken/wallet.db-wal' ]"
check "and the -shm too" "[ -e '$T/snap-taken/wallet.db-shm' ]"
check "and the volume was mounted READ ONLY for the copy" \
  "grep -q -- '-v fixture-volume:/d:ro' '$STUB_LOG'"

echo "== zallet cleanup: a wallet that CHANGES mid-copy is refused, not read"
# The db and its -wal are two cp calls, so they can straddle a checkpoint: the db is copied,
# zallet checkpoints, and the -wal that follows belongs to a different instant than the db it
# would be replayed against (SDE-UI, review of #637). A read-only mount rules out sqlite's own
# backup API, so the copy cannot be atomic - but it can notice, and a torn pair must be thrown
# away rather than read, because what it reports is a state that never existed.
zc_env
# WITH A CANDIDATE, or the second row below passes because there was nothing to report either
# way. Same trap as the read-only case above, and I walked into it twice.
export STUB_ZALLET_RUNNING=true STUB_TOUCH_DURING_COPY=1 STUB_SQL_OUT="7:AABBCC"
zc_run "$ABANDON" --read-only
check "a wallet written to between the db copy and the -wal copy refuses" \
  "[ $RC -eq 1 ] && grep -q 'A partial copy is not a reading' '$T/last.out'"
check "and it does not go on to report candidates from the torn pair" \
  "! grep -q 'would be abandoned' '$T/last.out'"
unset STUB_TOUCH_DURING_COPY

echo "== zallet cleanup: a wallet with no -wal is snapshotted, not refused"
# A checkpointed wallet has no sidecars. Copying only what exists is correct; refusing would
# make the read-only look fail on exactly the quiet wallet it is easiest to read.
zc_env
rm -f "$T/vol/wallet.db-wal" "$T/vol/wallet.db-shm"
export STUB_ZALLET_RUNNING=true
zc_run "$ABANDON" --read-only
check "it succeeds with no sidecars present" "[ $RC -eq 0 ]"
check "and the database was still copied" "[ -s '$T/snap-taken/wallet.db' ]"

echo "== zallet cleanup: a snapshot that CANNOT be taken is a refusal, not an empty answer"
# The failure this guards is the one that reads like good news: an unreadable volume gives an
# empty candidate list, which is indistinguishable from "nothing to clean up".
zc_env
rm -f "$T/vol/wallet.db"
export STUB_ZALLET_RUNNING=true
zc_run "$ABANDON" --read-only
check "a missing wallet.db refuses rather than reporting nothing to do" \
  "[ $RC -eq 1 ] && grep -q 'A partial copy is not a reading' '$T/last.out'"
check "and it does not claim there was nothing to clean" \
  "! grep -q 'nothing to do' '$T/last.out'"
