# shellcheck shell=bash
# prune.sh: the box's only Docker garbage collector, so the interesting assertions are
# about what it must NEVER do. A prune that deletes a volume deletes the chain or the
# wallet; one that deletes zcash-faucet:previous deletes the rollback the week it is
# needed. The docker double records every call so absence can be asserted on bytes, and
# each negative sits beside a positive so a script that did nothing could not pass.

PRUNE="$REPO/deploy/z3/prune.sh"

pr_env() {
  mk_scratch "${TMPDIR:-/tmp}/prune.XXXXXX"
  export STUB_LOG="$T/docker.log"; : > "$STUB_LOG"
  mkdir -p "$T/bin"
  export PATH="$T/bin:$BASE_PATH"
  export STUB_IMAGES="$T/images" STUB_IN_USE="$T/in-use"
  unset STUB_DOCKER_DOWN STUB_OLD_DOCKER STUB_BUILDER_FAIL STUB_IMAGE_PRUNE_FAIL STUB_DF_HANG STUB_VERSION_HANG \
        PRUNE_DRY_RUN PRUNE_KEEP_BUILD_CACHE PRUNE_DF_TIMEOUT PRUNE_VERSION_TIMEOUT 2>/dev/null
  # A docker that answers what prune.sh asks and logs what it is told to do. Output
  # shapes copied from a real Docker 29 daemon, including `docker ps --format {{.Image}}`
  # showing a bare 12-char id for a container whose tag has since moved.
  cat > "$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
[ -n "${STUB_DOCKER_DOWN:-}" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
case "$1 $2" in
  "version ") [ -n "${STUB_VERSION_HANG:-}" ] && sleep 30; exit 0 ;;
  "system df") [ -n "${STUB_DF_HANG:-}" ] && sleep 30; printf 'Images: 8.9GB (1.1GB reclaimable)\nBuild Cache: 53GB (53GB reclaimable)\n'; exit 0 ;;
  "builder prune")
    if [ "$3" = "--help" ]; then
      [ -n "${STUB_OLD_DOCKER:-}" ] && echo "  --keep-storage bytes  Amount of disk space to keep" || echo "  --reserved-space bytes  Amount of disk space always allowed to keep"
      exit 0
    fi
    [ -n "${STUB_BUILDER_FAIL:-}" ] && { echo "unknown flag: $3" >&2; exit 125; }
    echo "Total: 48.2GB"; exit 0 ;;
  "image prune")
    [ -n "${STUB_IMAGE_PRUNE_FAIL:-}" ] && { echo "Error response from daemon: conflict" >&2; exit 1; }
    echo "Total reclaimed space: 1.1GB"; exit 0 ;;
  "ps -a") cat "$STUB_IN_USE" 2>/dev/null; exit 0 ;;
  "images --format") cat "$STUB_IMAGES" 2>/dev/null; exit 0 ;;
esac
exit 0
STUB
  chmod +x "$T/bin/docker"
}

echo "== prune: the happy path reclaims cache and dangling layers and NOTHING else"
pr_env
printf 'zcash-faucet:latest\nzcash-faucet:previous\nzfnd/zebra:6.3.0\nzfnd/zebra:6.2.0\ncaddy:2\nalpine:3\n<none>:<none>\n' > "$STUB_IMAGES"
printf 'zcash-faucet:latest\nzfnd/zebra:6.3.0\ndddddddddddd\n' > "$STUB_IN_USE"
bash "$PRUNE" > "$T/out.log" 2>&1; echo $? > "$T/rc"
check "exits 0" "[ \"\$(cat '$T/rc')\" = 0 ]"
check "build cache pruned with the measured 20GB reserve, using the docker 29 flag" "grep -q '^docker builder prune -af --reserved-space 20GB$' '$STUB_LOG'"
check "dangling layers pruned WITHOUT -a" "grep -q '^docker image prune -f$' '$STUB_LOG'"
check "and both results are logged" "grep -q 'build cache: Total: 48.2GB' '$T/out.log' && grep -q 'dangling images: Total reclaimed space: 1.1GB' '$T/out.log'"
check "NEVER a volume prune" "! grep -q 'volume' '$STUB_LOG'"
check "NEVER a system or container prune" "! grep -qE 'system prune|container prune' '$STUB_LOG'"
check "NEVER an rmi of anything, however old or unused" "! grep -q 'rmi' '$STUB_LOG'"
check "docker was asked exactly two things that change state" "[ \"\$(grep -cE '^docker (builder prune -af|image prune)' '$STUB_LOG')\" = 2 ]"
check "unused tagged images are LISTED as information" "grep -q 'tagged images no container holds right now (kept' '$T/out.log' && grep -q 'zfnd/zebra:6.2.0' '$T/out.log'"
check "and the list excludes what a container holds and the dangling entries" "! grep 'no container holds' '$T/out.log' | grep -qE 'zfnd/zebra:6.3.0|zcash-faucet:latest|<none>'"
check "THE ROLLBACK IMAGE IS NEVER ON THAT LIST: it is held by no container by design" "! grep 'no container holds' '$T/out.log' | grep -q 'zcash-faucet:previous'"
check "and nothing in the journal tells a human to remove anything" "! grep -qi 'remove by hand' '$T/out.log'"
check "usage is logged before and after" "grep -q 'before: Images' '$T/out.log' && grep -q 'after: Images' '$T/out.log'"

echo "== prune: an older docker gets the flag it understands"
pr_env; export STUB_OLD_DOCKER=1
bash "$PRUNE" > /dev/null 2>&1
check "--keep-storage when --reserved-space is not offered" "grep -q 'builder prune -af --keep-storage 20GB' '$STUB_LOG'"

echo "== prune: A BUILD-CACHE PRUNE THAT FAILS IS A FAILED UNIT, not a quiet night"
# The one action that reclaims the 53 GB. If the flag guess is wrong on some docker, the
# command fails; a script that logged WARN and exited 0 would report success daily while
# the disk filled, which is the register entry itself.
pr_env; export STUB_BUILDER_FAIL=1
bash "$PRUNE" > "$T/bf.log" 2>&1; echo $? > "$T/rc"
check "exits nonzero, so OnFailure pages" "[ \"\$(cat '$T/rc')\" != 0 ]"
check "names the failure and docker's own words" "grep -q 'ERROR: builder prune failed: unknown flag' '$T/bf.log'"
check "still did the dangling prune, because one failure must not skip the rest" "grep -q '^docker image prune -f$' '$STUB_LOG'"

echo "== prune: a dangling prune that fails is a failed unit too"
pr_env; export STUB_IMAGE_PRUNE_FAIL=1
bash "$PRUNE" > "$T/if.log" 2>&1; echo $? > "$T/rc"
check "exits nonzero" "[ \"\$(cat '$T/rc')\" != 0 ]"
check "names it" "grep -q 'ERROR: image prune failed' '$T/if.log'"

echo "== prune: docker unreachable is a FAILED unit, and nothing was attempted"
pr_env; export STUB_DOCKER_DOWN=1
bash "$PRUNE" > "$T/down.log" 2>&1; echo $? > "$T/rc"
check "exits nonzero, so OnFailure pages" "[ \"\$(cat '$T/rc')\" != 0 ]"
check "says nothing was pruned" "grep -q 'nothing pruned' '$T/down.log'"
check "no prune command was issued" "! grep -qE 'prune -' '$STUB_LOG'"
check "but docker WAS asked, so the negative above is about a decision" "grep -q '^docker version' '$STUB_LOG'"

echo "== prune: a dry run names every action and performs none"
pr_env; export PRUNE_DRY_RUN=1
bash "$PRUNE" > "$T/dry.log" 2>&1; echo $? > "$T/rc"
check "exits 0" "[ \"\$(cat '$T/rc')\" = 0 ]"
check "the build prune is described, on one clean line" "grep -q 'build cache: would run: docker builder prune -af --reserved-space 20GB' '$T/dry.log'"
check "the dangling prune is described" "grep -q 'dangling images: would run: docker image prune -f' '$T/dry.log'"
check "and docker was never asked to change anything" "! grep -qE '^docker (builder prune -af|image prune)' '$STUB_LOG'"

echo "== prune: the reserve is an operator knob"
# A value that differs from the default, or this proves nothing (it did, when the default
# was raised to the same number).
pr_env; export PRUNE_KEEP_BUILD_CACHE=40GB
bash "$PRUNE" > /dev/null 2>&1
check "the configured reserve reaches docker" "grep -q 'builder prune -af --reserved-space 40GB' '$STUB_LOG'"

echo "== prune: THE UNIT BOUNDS THE DELETES AT TWO HOURS, and this is where that is pinned"
# A Type=oneshot has NO start timeout by default (systemd exempts oneshots from
# DefaultTimeoutStartSec; the box shows TimeoutStartUSec=infinity on faucet-autodeploy).
# So without this line a prune against a wedged daemon runs forever and nothing pages;
# with it, two hours is generous for 50 GB of deletes and then it fails loud, the way
# zsnap-export bounds its own long job.
check "faucet-prune.service declares TimeoutStartSec=2h" "grep -qx 'TimeoutStartSec=2h' '$REPO/deploy/z3/faucet-prune.service'"
check "and OnFailure, so a real failure pages" "grep -qx 'OnFailure=faucet-alert@%n.service' '$REPO/deploy/z3/faucet-prune.service'"

echo "== prune: a daemon that hangs on 'docker version' fails FAST, within its own bound, not the unit's two hours"
pr_env; export STUB_VERSION_HANG=1 PRUNE_VERSION_TIMEOUT=1
start=$(date +%s); bash "$PRUNE" > "$T/vh.log" 2>&1; echo $? > "$T/rc"; took=$(( $(date +%s) - start ))
check "exits nonzero" "[ \"\$(cat '$T/rc')\" != 0 ]"
check "within a few seconds, not thirty" "[ $took -lt 10 ]"
check "and says the daemon gave no answer in the bound" "grep -q 'not reachable (no answer in 1s)' '$T/vh.log'"
check "and pruned nothing" "! grep -qE 'prune -' '$STUB_LOG'"

echo "== prune: a 'docker system df' that hangs degrades the usage line and the run still finishes"
pr_env; export STUB_DF_HANG=1 PRUNE_DF_TIMEOUT=1
start=$(date +%s); bash "$PRUNE" > "$T/dfh.log" 2>&1; echo $? > "$T/rc"; took=$(( $(date +%s) - start ))
check "exits 0: usage is context, not the job" "[ \"\$(cat '$T/rc')\" = 0 ]"
check "finished within the bounds, not after two hangs of thirty seconds" "[ $took -lt 15 ]"
check "the usage lines say the answer was not usable" "grep -q 'before: (docker system df gave no usable answer)' '$T/dfh.log' && grep -q 'after: (docker system df gave no usable answer)' '$T/dfh.log'"
check "and the prunes still ran" "grep -q '^docker builder prune -af' '$STUB_LOG' && grep -q '^docker image prune -f$' '$STUB_LOG'"
