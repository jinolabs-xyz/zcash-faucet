# shellcheck shell=bash
# zallet-truncate-wallet.sh: the mid-incident repair for a commitment-tree conflict. It
# opens the FUNDS database with a zallet binary, and until 2026-09-09 the binary was a
# pin in the script, v0.1.0-beta.1, while the wallet had moved to beta.3 (risk register
# #14). The repair now runs the image the wallet container runs, read off the container,
# and refuses when it cannot read one. A docker double records what the script would
# have run, so the assertions are about the image handed to `docker run`, not about
# "it did not crash".

TRUNC="$REPO/deploy/z3/zallet-truncate-wallet.sh"

zr_env() {
  mk_scratch "${TMPDIR:-/tmp}/zalletrepair.XXXXXX"
  mkdir -p "$T/bin" "$T/vol"
  export STUB_LOG="$T/docker.calls"; : > "$STUB_LOG"
  # A wallet.db to find, at a path the suite owns.
  printf 'sqlite' > "$T/vol/wallet.db"
  export ZALLET_WALLET_DB="$T/vol/wallet.db" ZALLET_CONTAINER="zallet-under-test"
  unset ZALLET_IMAGE STUB_INSPECT_IMAGE STUB_INSPECT_ID STUB_INSPECT_USER STUB_INSPECT_FAIL STUB_INSPECT_ERR STUB_RUN_RC STUB_START_RC \
        STUB_CP_FAIL STUB_WD_STATE STUB_STOP_STICKS 2>/dev/null
  export STUB_INSPECT_ID="sha256:6cf065f7aaaa"
  # The double: inspect answers the NAME for {{.Config.Image}}, the ID for {{.Image}}, the
  # user for {{.Config.User}} and the running state for {{.State.Running}} (false after a
  # stop, unless STUB_STOP_STICKS=1 models a stop that did not take), or fails with
  # STUB_INSPECT_ERR; run exits STUB_RUN_RC, start exits STUB_START_RC.
  cat > "$T/bin/docker" <<'D'
#!/usr/bin/env bash
echo "docker $*" >> "${STUB_LOG:?}"
case "$1" in
  inspect)
    [ "${STUB_INSPECT_FAIL:-0}" = "1" ] && { echo "${STUB_INSPECT_ERR:-Error: No such object: $4}" >&2; exit 1; }
    case "$3" in
      '{{.Config.Image}}') printf '%s\n' "${STUB_INSPECT_IMAGE:?}" ;;
      '{{.Image}}') printf '%s\n' "${STUB_INSPECT_ID:?}" ;;
      '{{.Config.User}}') printf '%s\n' "${STUB_INSPECT_USER:-}" ;;
      '{{.State.Running}}') if [ "${STUB_STOP_STICKS:-0}" = "1" ] || [ ! -e "${STUB_STOPPED_MARK:?}" ]; then echo true; else echo false; fi ;;
      *) echo "double: unsupported format $3" >&2; exit 64 ;;
    esac ;;
  run) exit "${STUB_RUN_RC:-0}" ;;
  start) rm -f "${STUB_STOPPED_MARK:?}"; exit "${STUB_START_RC:-0}" ;;
  stop) touch "${STUB_STOPPED_MARK:?}"; exit 0 ;;
  *) echo "double: unsupported $*" >&2; exit 64 ;;
esac
D
  chmod +x "$T/bin/docker"
  export STUB_STOPPED_MARK="$T/stopped"; rm -f "$STUB_STOPPED_MARK"
  # A systemctl double: the watchdog reports STUB_WD_STATE (default inactive).
  cat > "$T/bin/systemctl" <<'S'
#!/usr/bin/env bash
echo "systemctl $*" >> "${STUB_LOG:?}"
[ "$1" = "is-active" ] || exit 64
state="${STUB_WD_STATE:-inactive}"
echo "$state"; [ "$state" = "active" ] && exit 0; exit 3
S
  chmod +x "$T/bin/systemctl"
  # cp is the real one unless STUB_CP_FAIL=1, for the no-backup case.
  cat > "$T/bin/cp" <<'C'
#!/usr/bin/env bash
[ "${STUB_CP_FAIL:-0}" = "1" ] && { echo "cp: write error: No space left on device" >&2; exit 1; }
exec /bin/cp "$@"
C
  chmod +x "$T/bin/cp"
  export PATH="$T/bin:$BASE_PATH"
}

echo "== zallet-truncate: the repair runs the IMAGE ID the wallet container runs, not a pin and not the tag"
# .Config.Image is the name the container was created with; .Image is the ID it runs. A
# tag re-pushed or re-tagged under a running container names a different binary than
# the one holding wallet.db (review reproduced it: same tag, two IDs). The ID runs; the
# name is checked and logged for the human.
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" bash "$TRUNC" 4282400 > "$T/run.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "asked the container for its image NAME and its image ID" "grep -q 'docker inspect --format {{.Config.Image}} zallet-under-test' '$STUB_LOG' && grep -q 'docker inspect --format {{.Image}} zallet-under-test' '$STUB_LOG'"
check "and ran the truncate with the ID" "grep -q 'docker run .*--volumes-from zallet-under-test .*sha256:6cf065f7aaaa .*repair truncate-wallet 4282400' '$STUB_LOG'"
check "never with the tag, which can move" "! grep -q 'docker run .*zodlinc/zallet:v0.1.0-beta.3 ' '$STUB_LOG'"
check "the old pin appears nowhere: no default image in the script, none in the calls" "! grep -q 'beta.1' '$STUB_LOG' && ! grep -qE 'ZALLET_IMAGE:-[^}]' '$TRUNC'"
check "the log names both, and says which one runs" "grep -q 'image: zodlinc/zallet:v0.1.0-beta.3, running as sha256:6cf065f7aaaa (from the container zallet-under-test' '$T/run.log'"
check "the watchdog was asked before anything else" "awk '/systemctl is-active faucet-watchdog.service/{w=NR} /docker stop/{s=NR} END{exit !(w && s && w<s)}' '$STUB_LOG'"
check "zallet was stopped, CONFIRMED down, then the truncate ran, then it was started" \
  "awk '/docker stop/{s=NR} /State.Running/{c=NR} /docker run/{r=NR} /docker start/{t=NR} END{exit !(s && c && r && t && s<c && c<r && r<t)}' '$STUB_LOG'"
check "no --user was passed for a container with the image default user" "! grep -q 'docker run.*--user' '$STUB_LOG'"
check "the backup line tells how to put it back, watchdog first, sidecars off before the main file, and chowned" \
  "awk '/to put it back/{r=1} r&&/systemctl stop faucet-watchdog.service/{w=NR} r&&/rm -f .*-wal/{x=NR} r&&/cp -f/&&!/for s in/{c=NR} r&&/chown --reference/{o=NR} r&&/systemctl start faucet-watchdog.service/{s=NR} END{exit !(w && x && c && o && s && w<x && x<c && c<=o && o<s)}' '$T/run.log'"
check "and the done block says to start the watchdog again" "grep -q 'Now: systemctl start faucet-watchdog.service' '$T/run.log'"

echo "== zallet-truncate: the repair runs AS the container's user when it has one"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_INSPECT_USER="1000:1000" bash "$TRUNC" 4282400 > "$T/user.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "docker run carries --user 1000:1000" "grep -q 'docker run .*--user 1000:1000 .*sha256:6cf065f7aaaa ' '$STUB_LOG'"
check "and the log says whose identity" "grep -q 'user: 1000:1000' '$T/user.log'"

echo "== zallet-truncate: the backup takes the -wal and -shm sidecars with it"
zr_env
printf 'wal' > "$T/vol/wallet.db-wal"; printf 'shm' > "$T/vol/wallet.db-shm"
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" bash "$TRUNC" 4282400 > "$T/sidecars.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "the -wal and -shm were copied beside the backup" "ls '$T/vol/'wallet.db.bak-pretruncate-*-wal >/dev/null 2>&1 && ls '$T/vol/'wallet.db.bak-pretruncate-*-shm >/dev/null 2>&1"
check "and the log says so" "grep -q 'backup: .*(+ -wal, -shm)' '$T/sidecars.log'"

echo "== zallet-truncate: a stop that did not take is an abort, not a truncate beside a live daemon"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_STOP_STICKS=1 bash "$TRUNC" 4282400 > "$T/stuck.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "says the container is still running, and to start the watchdog again" "grep -q 'still running (State.Running=true)' '$T/stuck.log' && grep -q 'systemctl start faucet-watchdog.service' '$T/stuck.log'"
check "and nothing was run against the database, no backup written" "! grep -q 'docker run' '$STUB_LOG' && ! ls '$T/vol/'wallet.db.bak-* >/dev/null 2>&1"

echo "== zallet-truncate: NO CONTAINER IS AN ABORT, before anything is stopped, showing docker's own words"
# --volumes-from needs the container (stopped is fine, removed is not), and the old
# advice \"set ZALLET_IMAGE if the container is gone\" led to docker run failing 125 after
# a second copy of the funds db had been written and a false \"zallet was restarted\".
zr_env
STUB_INSPECT_FAIL=1 STUB_INSPECT_ERR="Error response from daemon: No such container: zallet-under-test" bash "$TRUNC" 4282400 > "$T/noimg.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "shows docker's error and says the container must exist" "grep -q 'No such container: zallet-under-test' '$T/noimg.log' && grep -q 'has to exist (stopped is fine)' '$T/noimg.log'"
check "does not send the operator to an override for a container that is gone" "! grep -qi 'container is gone' '$T/noimg.log'"
check "zallet was NOT stopped" "! grep -q 'docker stop' '$STUB_LOG'"
check "no backup copy was written" "! ls '$T/vol/'wallet.db.bak-* >/dev/null 2>&1"
check "and nothing was run against the database" "! grep -q 'docker run' '$STUB_LOG'"
zr_env
STUB_INSPECT_FAIL=1 STUB_INSPECT_ERR="permission denied while trying to connect to the Docker daemon socket" bash "$TRUNC" 4282400 > "$T/socket.log" 2>&1
check "a socket problem is shown as a socket problem, not as a wrong container name" "grep -q 'permission denied while trying to connect' '$T/socket.log'"

echo "== zallet-truncate: an explicit ZALLET_IMAGE override wins, is on record as an override, and may be a bare ID"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" ZALLET_IMAGE="zodlinc/zallet:v0.1.0-beta.4" bash "$TRUNC" 4282400 > "$T/override.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "ran the override" "grep -q 'docker run .*zodlinc/zallet:v0.1.0-beta.4 ' '$STUB_LOG'"
check "still inspected the container, which has to exist" "grep -q 'docker inspect' '$STUB_LOG'"
check "and the log says it was an override, beside what the container runs" "grep -q 'from ZALLET_IMAGE, an override you set; the container runs zodlinc/zallet:v0.1.0-beta.3 = sha256:6cf065f7aaaa' '$T/override.log'"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" ZALLET_IMAGE="sha256:1849b4469875abcd" bash "$TRUNC" 4282400 > "$T/id.log" 2>&1
check "a sha256: image ID is accepted as the most exact reference there is" "[ $? -eq 0 ] && grep -q 'docker run .*sha256:1849b4469875abcd ' '$STUB_LOG'"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" ZALLET_IMAGE="1849b4469875" bash "$TRUNC" 4282400 > "$T/hex.log" 2>&1
check "a bare hex ID, the form docker images -q prints, is accepted too" "[ $? -eq 0 ] && grep -q 'docker run .*1849b4469875 ' '$STUB_LOG'"
zr_env
STUB_INSPECT_IMAGE="sha256:1849b4469875abcd0000" ZALLET_IMAGE="zodlinc/zallet:v0.1.0-beta.3" bash "$TRUNC" 4282400 > "$T/idname.log" 2>&1
check "a container whose own name is an ID is not refused when an override says what it is" "[ $? -eq 0 ] && grep -q 'docker run .*zodlinc/zallet:v0.1.0-beta.3 ' '$STUB_LOG'"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" ZALLET_IMAGE="zfnd/zebra:v6.3.0" bash "$TRUNC" 4282400 > "$T/badoverride.log" 2>&1
check "an override that is neither a zallet name nor an ID is refused" "[ $? -ne 0 ] && grep -q 'neither a zallet image by name nor an image ID' '$T/badoverride.log' && ! grep -q 'docker stop' '$STUB_LOG'"

echo "== zallet-truncate: a container that is not zallet is refused"
zr_env
STUB_INSPECT_IMAGE="zfnd/zebra:v6.3.0" bash "$TRUNC" 4282400 > "$T/wrong.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "names the image" "grep -q 'does not look like a zallet image' '$T/wrong.log' && grep -q 'zfnd/zebra:v6.3.0' '$T/wrong.log'"
check "and stopped nothing" "! grep -q 'docker stop' '$STUB_LOG'"

echo "== zallet-truncate: a watchdog that is not DEFINITELY down is an abort: active, activating, or could-not-tell"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_WD_STATE=active bash "$TRUNC" 4282400 > "$T/wd.log" 2>&1
check "active: exits nonzero" "[ $? -ne 0 ]"
check "says to stop the watchdog, and how" "grep -q 'faucet-watchdog.service is active' '$T/wd.log' && grep -q 'systemctl stop faucet-watchdog.service' '$T/wd.log'"
check "and touched nothing: no inspect, no stop, no run" "! grep -q 'docker' '$STUB_LOG'"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_WD_STATE=activating bash "$TRUNC" 4282400 > "$T/wdact.log" 2>&1
check "activating (Restart=always mid-loop): exits nonzero, touched nothing" "[ $? -ne 0 ] && grep -q 'is activating' '$T/wdact.log' && ! grep -q 'docker' '$STUB_LOG'"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_WD_STATE=unknown bash "$TRUNC" 4282400 > "$T/wdunk.log" 2>&1
check "unknown (a mistyped unit name): could-not-tell is an abort" "[ $? -ne 0 ] && grep -q 'could not tell whether' '$T/wdunk.log' && ! grep -q 'docker' '$STUB_LOG'"
zr_env
# A systemctl that answers NOTHING, which is what "no systemctl", a wrong unit name or a
# broken bus all look like to this script. Deleting the stub instead would expose the
# runner's REAL systemctl (CI has one, and it answers "inactive" for a unit it has never
# heard of), so the case would prove the opposite of what it says.
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/bin/systemctl"; chmod +x "$T/bin/systemctl"
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" bash "$TRUNC" 4282400 > "$T/wdnone.log" 2>&1
check "a systemctl that says nothing: could-not-tell is an abort too" "[ $? -ne 0 ] && grep -q 'could not tell whether' '$T/wdnone.log' && ! grep -q 'docker' '$STUB_LOG'"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_WD_STATE=failed bash "$TRUNC" 4282400 > "$T/wdfailed.log" 2>&1
check "failed is definitely down: the repair proceeds" "[ $? -eq 0 ] && grep -q 'docker run' '$STUB_LOG'"

echo "== zallet-truncate: NO BACKUP, NO TRUNCATE"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_CP_FAIL=1 bash "$TRUNC" 4282400 > "$T/nobak.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "says the backup failed and refuses" "grep -q 'No truncate without a backup' '$T/nobak.log'"
check "and tells the operator to start the watchdog again" "grep -q 'systemctl start faucet-watchdog.service' '$T/nobak.log'"
check "nothing was run against the database" "! grep -q 'docker run' '$STUB_LOG'"
check "and zallet was started again on the untouched state" "grep -q 'docker start zallet-under-test' '$STUB_LOG' && grep -q 'started again on the untouched state' '$T/nobak.log'"

echo "== zallet-truncate: a failed truncate restarts zallet on the pre-truncate state and exits its code"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_RUN_RC=3 bash "$TRUNC" 4282400 > "$T/fail.log" 2>&1
check "exits with the truncate's code" "[ $? -eq 3 ]"
check "says it failed and where the backup is" "grep -q 'TRUNCATE FAILED (exit 3)' '$T/fail.log' && grep -q 'wallet.db.bak-pretruncate-' '$T/fail.log'"
check "and zallet was started again, and the line says so truthfully" "grep -q 'docker start zallet-under-test' '$STUB_LOG' && grep -q 'zallet was started again, on the pre-truncate state' '$T/fail.log'"
check "a backup file exists beside the db" "ls '$T/vol/'wallet.db.bak-pretruncate-* >/dev/null 2>&1"

echo "== zallet-truncate: a restart that FAILS is said, not asserted"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_RUN_RC=3 STUB_START_RC=1 bash "$TRUNC" 4282400 > "$T/nostart.log" 2>&1
check "the failure line says zallet could NOT be started, and to start it by hand" "grep -q 'could NOT be started again' '$T/nostart.log' && grep -q 'start it by hand' '$T/nostart.log'"
check "and never claims it was restarted" "! grep -q 'zallet was started again' '$T/nostart.log'"
check "and the failure path too says to start the watchdog again" "grep -q 'Then: systemctl start faucet-watchdog.service' '$T/nostart.log'"

echo "== zallet-truncate: a bad height is usage, before docker is touched"
zr_env
bash "$TRUNC" notanumber > "$T/usage.log" 2>&1
check "exits 2" "[ $? -eq 2 ]"
check "no docker call at all" "[ ! -s '$STUB_LOG' ]"

echo "== zallet-truncate: a stop whose state cannot be READ is an abort too, not a truncate on a guess"
zr_env
cat > "$T/bin/docker" <<'D'
#!/usr/bin/env bash
echo "docker $*" >> "${STUB_LOG:?}"
case "$1" in
  inspect) case "$3" in
      '{{.Config.Image}}') echo "zodlinc/zallet:v0.1.0-beta.3" ;;
      '{{.Image}}') echo "sha256:6cf065f7aaaa" ;;
      '{{.Config.User}}') echo "" ;;
      '{{.State.Running}}') echo "Error: No such object" >&2; exit 1 ;;
    esac ;;
  stop|start) exit 0 ;;
  *) echo "double: unsupported $*" >&2; exit 64 ;;
esac
D
chmod +x "$T/bin/docker"
bash "$TRUNC" 4282400 > "$T/unknownstate.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "says it could not read the state" "grep -q 'could not read whether zallet-under-test is running' '$T/unknownstate.log'"
check "nothing was run against the database and no backup was written" "! grep -q 'docker run' '$STUB_LOG' && ! ls '$T/vol/'wallet.db.bak-* >/dev/null 2>&1"

# Nothing this suite exports may leak into whatever SUITES lists after it.
unset ZALLET_WALLET_DB ZALLET_CONTAINER STUB_LOG STUB_INSPECT_ID STUB_INSPECT_USER STUB_STOPPED_MARK ZALLET_IMAGE
