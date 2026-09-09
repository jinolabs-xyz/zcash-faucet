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
  unset ZALLET_IMAGE STUB_INSPECT_IMAGE STUB_INSPECT_FAIL STUB_RUN_RC 2>/dev/null
  # The double: inspect answers with STUB_INSPECT_IMAGE (or fails), run exits STUB_RUN_RC.
  cat > "$T/bin/docker" <<'D'
#!/usr/bin/env bash
echo "docker $*" >> "${STUB_LOG:?}"
case "$1" in
  inspect)
    [ "${STUB_INSPECT_FAIL:-0}" = "1" ] && { echo "Error: No such object: $3" >&2; exit 1; }
    printf '%s\n' "${STUB_INSPECT_IMAGE:?}" ;;
  run) exit "${STUB_RUN_RC:-0}" ;;
  stop|start) exit 0 ;;
  *) echo "double: unsupported $*" >&2; exit 64 ;;
esac
D
  chmod +x "$T/bin/docker"
  export PATH="$T/bin:$BASE_PATH"
}

echo "== zallet-truncate: the repair runs the image the wallet container RUNS, not a pin"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" bash "$TRUNC" 4282400 > "$T/run.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "asked the container which image it runs" "grep -q 'docker inspect --format {{.Config.Image}} zallet-under-test' '$STUB_LOG'"
check "and ran the truncate with THAT image" "grep -q 'docker run .*zodlinc/zallet:v0.1.0-beta.3 .*repair truncate-wallet 4282400' '$STUB_LOG'"
check "the old pin appears nowhere: no default image in the script, none in the calls" "! grep -q 'beta.1' '$STUB_LOG' && ! grep -qE 'ZALLET_IMAGE:-[^}]' '$TRUNC'"
check "the log says where the image came from" "grep -q 'image: zodlinc/zallet:v0.1.0-beta.3 (from the running container zallet-under-test)' '$T/run.log'"
check "zallet was stopped before the truncate and started after" \
  "awk '/docker stop/{s=NR} /docker run/{r=NR} /docker start/{t=NR} END{exit !(s && r && t && s<r && r<t)}' '$STUB_LOG'"

echo "== zallet-truncate: NO READABLE IMAGE IS AN ABORT, before anything is stopped"
zr_env
STUB_INSPECT_FAIL=1 bash "$TRUNC" 4282400 > "$T/noimg.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "says it could not read the image and names the fix" "grep -q 'could not read the image of container zallet-under-test' '$T/noimg.log' && grep -q 'ZALLET_IMAGE' '$T/noimg.log'"
check "zallet was NOT stopped" "! grep -q 'docker stop' '$STUB_LOG'"
check "and nothing was run against the database" "! grep -q 'docker run' '$STUB_LOG'"

echo "== zallet-truncate: an explicit ZALLET_IMAGE override wins and is on record as an override"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" ZALLET_IMAGE="zodlinc/zallet:v0.1.0-beta.4" bash "$TRUNC" 4282400 > "$T/override.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "ran the override" "grep -q 'docker run .*zodlinc/zallet:v0.1.0-beta.4 ' '$STUB_LOG'"
check "did not ask the container" "! grep -q 'docker inspect' '$STUB_LOG'"
check "and the log says it was an override, not the running container" "grep -q 'from ZALLET_IMAGE (an override you set' '$T/override.log'"

echo "== zallet-truncate: an image that is not zallet is refused, whichever way it arrived"
zr_env
STUB_INSPECT_IMAGE="zfnd/zebra:v6.3.0" bash "$TRUNC" 4282400 > "$T/wrong.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "names the image and the source" "grep -q 'does not look like a zallet image' '$T/wrong.log' && grep -q 'zfnd/zebra:v6.3.0' '$T/wrong.log'"
check "and stopped nothing" "! grep -q 'docker stop' '$STUB_LOG'"

echo "== zallet-truncate: a failed truncate restarts zallet on the pre-truncate state and exits its code"
zr_env
STUB_INSPECT_IMAGE="zodlinc/zallet:v0.1.0-beta.3" STUB_RUN_RC=3 bash "$TRUNC" 4282400 > "$T/fail.log" 2>&1
check "exits with the truncate's code" "[ $? -eq 3 ]"
check "says it failed and where the backup is" "grep -q 'TRUNCATE FAILED (exit 3)' '$T/fail.log' && grep -q 'wallet.db.bak-pretruncate-' '$T/fail.log'"
check "and zallet was started again" "grep -q 'docker start zallet-under-test' '$STUB_LOG'"
check "a backup file exists beside the db" "ls '$T/vol/'wallet.db.bak-pretruncate-* >/dev/null 2>&1"

echo "== zallet-truncate: a bad height is usage, before docker is touched"
zr_env
bash "$TRUNC" notanumber > "$T/usage.log" 2>&1
check "exits 2" "[ $? -eq 2 ]"
check "no docker call at all" "[ ! -s '$STUB_LOG' ]"
