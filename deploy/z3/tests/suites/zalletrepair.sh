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
  unset ZALLET_IMAGE STUB_INSPECT_IMAGE STUB_INSPECT_ID STUB_INSPECT_FAIL STUB_INSPECT_ERR STUB_RUN_RC STUB_START_RC STUB_CP_FAIL STUB_WD_ACTIVE 2>/dev/null
  export STUB_INSPECT_ID="sha256:6cf065f7aaaa"
  # The double: inspect answers the NAME for {{.Config.Image}} and the ID for {{.Image}}
  # (or fails with STUB_INSPECT_ERR), run exits STUB_RUN_RC, start exits STUB_START_RC.
  cat > "$T/bin/docker" <<'D'
#!/usr/bin/env bash
echo "docker $*" >> "${STUB_LOG:?}"
case "$1" in
  inspect)
    [ "${STUB_INSPECT_FAIL:-0}" = "1" ] && { echo "${STUB_INSPECT_ERR:-Error: No such object: $4}" >&2; exit 1; }
    case "$3" in
      '{{.Config.Image}}') printf '%s\n' "${STUB_INSPECT_IMAGE:?}" ;;
      '{{.Image}}') printf '%s\n' "${STUB_INSPECT_ID:?}" ;;
      *) echo "double: unsupported format $3" >&2; exit 64 ;;
    esac ;;
  run) exit "${STUB_RUN_RC:-0}" ;;
  start) exit "${STUB_START_RC:-0}" ;;
  stop) exit 0 ;;
  *) echo "double: unsupported $*" >&2; exit 64 ;;
esac
D
  chmod +x "$T/bin/docker"
  # A systemctl double: the watchdog is inactive unless STUB_WD_ACTIVE=1.
  cat > "$T/bin/systemctl" <<'S'
#!/usr/bin/env bash
echo "systemctl $*" >> "${STUB_LOG:?}"
[ "$1" = "is-active" ] || exit 64
if [ "${STUB_WD_ACTIVE:-0}" = "1" ]; then echo active; exit 0; else echo inactive; exit 3; fi
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
check "zallet was stopped before the truncate and started after" \
  "awk '/docker stop/{s=NR} /docker run/{r=NR} /docker start/{t=NR} END{exit !(s && r && t && s<r && r<t)}' '$STUB_LOG'"

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
check "a bare image ID is accepted as the most exact reference there is" "[ $? -eq 0 ] && grep -q 'docker run .*sha256:1849b4469875abcd ' '$STUB_LOG'"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" ZALLET_IMAGE="zfnd/zebra:v6.3.0" bash "$TRUNC" 4282400 > "$T/badoverride.log" 2>&1
check "an override that is neither a zallet name nor an ID is refused" "[ $? -ne 0 ] && grep -q 'neither a zallet image by name nor an image ID' '$T/badoverride.log' && ! grep -q 'docker stop' '$STUB_LOG'"

echo "== zallet-truncate: a container that is not zallet is refused"
zr_env
STUB_INSPECT_IMAGE="zfnd/zebra:v6.3.0" bash "$TRUNC" 4282400 > "$T/wrong.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "names the image" "grep -q 'does not look like a zallet image' '$T/wrong.log' && grep -q 'zfnd/zebra:v6.3.0' '$T/wrong.log'"
check "and stopped nothing" "! grep -q 'docker stop' '$STUB_LOG'"

echo "== zallet-truncate: an ACTIVE watchdog is an abort: it would docker-start zallet mid-repair"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_WD_ACTIVE=1 bash "$TRUNC" 4282400 > "$T/wd.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "says to stop the watchdog, and how" "grep -q 'faucet-watchdog.service is active' '$T/wd.log' && grep -q 'systemctl stop faucet-watchdog.service' '$T/wd.log'"
check "and touched nothing: no inspect, no stop, no run" "! grep -q 'docker' '$STUB_LOG'"

echo "== zallet-truncate: NO BACKUP, NO TRUNCATE"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_CP_FAIL=1 bash "$TRUNC" 4282400 > "$T/nobak.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "says the backup failed and refuses" "grep -q 'No truncate without a backup' '$T/nobak.log'"
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

echo "== zallet-truncate: a bad height is usage, before docker is touched"
zr_env
bash "$TRUNC" notanumber > "$T/usage.log" 2>&1
check "exits 2" "[ $? -eq 2 ]"
check "no docker call at all" "[ ! -s '$STUB_LOG' ]"
