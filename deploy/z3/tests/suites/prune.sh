# shellcheck shell=bash
# prune.sh: the box's only Docker garbage collector, so the interesting assertions are
# about what it must NEVER do. A prune that deletes a volume deletes the chain or the
# wallet; one that deletes zcash-faucet:previous deletes the rollback the week it is
# needed. The docker double records every call so absence can be asserted on bytes.

PRUNE="$REPO/deploy/z3/prune.sh"

pr_env() {
  mk_scratch "${TMPDIR:-/tmp}/prune.XXXXXX"
  export STUB_LOG="$T/docker.log"; : > "$STUB_LOG"
  mkdir -p "$T/bin"
  export PATH="$T/bin:$BASE_PATH"
  export STUB_IMAGES="$T/images" STUB_IN_USE="$T/in-use" STUB_IN_USE_IDS="$T/in-use-ids"
  unset STUB_DOCKER_DOWN STUB_OLD_DOCKER PRUNE_KEEP_IMAGES PRUNE_IMAGE_AGE_DAYS PRUNE_DRY_RUN PRUNE_KEEP_BUILD_CACHE 2>/dev/null
  export PRUNE_PIN_FILE="$T/env.testnet"
  : > "$PRUNE_PIN_FILE"
  # A docker that answers what prune.sh asks and logs what it is told to do.
  cat > "$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
[ -n "${STUB_DOCKER_DOWN:-}" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
case "$1 $2" in
  "version ") exit 0 ;;
  "system df") printf 'Images: 8.9GB (1.1GB reclaimable)\nBuild Cache: 53GB (53GB reclaimable)\n'; exit 0 ;;
  "builder prune")
    if [ "$3" = "--help" ]; then
      [ -n "${STUB_OLD_DOCKER:-}" ] && echo "  --keep-storage bytes  Amount of disk space to keep" || echo "  --reserved-space bytes  Amount of disk space always allowed to keep"
      exit 0
    fi
    echo "Total: 48.2GB"; exit 0 ;;
  "image prune") echo "Total reclaimed space: 1.1GB"; exit 0 ;;
  "ps -a")
    case "$*" in
      *'{{.ImageID}}'*) cat "$STUB_IN_USE_IDS" 2>/dev/null ;;
      *) cat "$STUB_IN_USE" 2>/dev/null ;;
    esac; exit 0 ;;
  "images --format") cat "$STUB_IMAGES" 2>/dev/null; exit 0 ;;
  "rmi "*) exit 0 ;;
esac
exit 0
STUB
  chmod +x "$T/bin/docker"
}
# $1 repo:tag, $2 short id, $3 age in days -> one line in the images double
img() { printf '%s\t%s\t%s +0000 UTC\n' "$1" "$2" "$(date -u -d "-$3 days" '+%F %T')" >> "$STUB_IMAGES"; }

echo "== prune: the happy path reclaims cache and dangling layers and NOTHING it must not"
pr_env
img zcash-faucet:latest   aaaaaaaaaaaa 0
img zcash-faucet:previous bbbbbbbbbbbb 45      # older than the age, unused by a container: THE rollback
img zfnd/zebra:6.3.0      cccccccccccc 60      # in use by tag
img caddy:2               dddddddddddd 90      # in use only by id (retagged since)
img zfnd/zebra:6.2.0      eeeeeeeeeeee 40      # the upgrade left it behind: the one to remove
img alpine:3              ffffffffffff 3       # unused but young
img '<none>:<none>'       111111111111 200     # dangling: image prune's job, not rmi's
printf 'zcash-faucet:latest\nzfnd/zebra:6.3.0\nsha256:dddddddddddd0000\n' > "$STUB_IN_USE"
printf 'sha256:aaaaaaaaaaaa0000\nsha256:cccccccccccc0000\nsha256:dddddddddddd0000\n' > "$STUB_IN_USE_IDS"
bash "$PRUNE" > "$T/out.log" 2>&1; echo $? > "$T/rc"
check "exits 0" "[ \"\$(cat '$T/rc')\" = 0 ]"
check "build cache pruned with the 5GB reserve, using the docker 29 flag" "grep -q 'docker builder prune -af --reserved-space 5GB' '$STUB_LOG'"
check "dangling layers pruned WITHOUT -a" "grep -q '^docker image prune -f$' '$STUB_LOG'"
check "NEVER a volume prune" "! grep -q 'volume' '$STUB_LOG'"
check "NEVER a system or container prune" "! grep -qE 'system prune|container prune' '$STUB_LOG'"
check "the old zebra image, unused for 40 days, is removed" "grep -q 'docker rmi zfnd/zebra:6.2.0' '$STUB_LOG'"
check "and the log says so, with its age" "grep -q 'removing unused image zfnd/zebra:6.2.0 (40d old)' '$T/out.log'"
check "the rollback image is NEVER removed, however old" "! grep -q 'rmi zcash-faucet:previous' '$STUB_LOG'"
check "the running image is never removed" "! grep -q 'rmi zcash-faucet:latest' '$STUB_LOG'"
check "an image in use by tag is never removed" "! grep -q 'rmi zfnd/zebra:6.3.0' '$STUB_LOG'"
check "an image in use only by id is never removed" "! grep -q 'rmi caddy:2' '$STUB_LOG'"
check "a young unused image is left for the age to decide" "! grep -q 'rmi alpine:3' '$STUB_LOG'"
check "dangling entries are not fed to rmi" "! grep -q 'rmi <none>' '$STUB_LOG'"
check "exactly one image removed, and the summary says one" "[ \"\$(grep -c 'docker rmi ' '$STUB_LOG')\" = 1 ] && grep -q 'unused tagged images removed: 1' '$T/out.log'"
check "usage is logged before and after" "grep -q '^.*before: Images' '$T/out.log' && grep -q '^.*after: Images' '$T/out.log'"

echo "== prune: an image the stack's pin file names is protected even when unused and old"
pr_env
img zodlinc/zallet:v0.1.0-beta.4 999999999999 50
printf 'Z3_ZEBRA_IMAGE=zfnd/zebra:6.3.0\nZ3_ZALLET_IMAGE="zodlinc/zallet:v0.1.0-beta.4"\n' > "$PRUNE_PIN_FILE"
bash "$PRUNE" > /dev/null 2>&1
check "the pinned image survives to its upgrade" "! grep -q 'rmi zodlinc/zallet:v0.1.0-beta.4' '$STUB_LOG'"

echo "== prune: the keep list and the age are operator knobs"
pr_env
img ghcr.io/thing:1 121212121212 10
img ghcr.io/other:1 343434343434 10
PRUNE_IMAGE_AGE_DAYS=7 PRUNE_KEEP_IMAGES="ghcr.io/thing:1" bash "$PRUNE" > /dev/null 2>&1
check "a shorter age removes the 10-day image" "grep -q 'rmi ghcr.io/other:1' '$STUB_LOG'"
check "the keep list protects the other, replacing the default list" "! grep -q 'rmi ghcr.io/thing:1' '$STUB_LOG'"

echo "== prune: an older docker gets the flag it understands"
pr_env; export STUB_OLD_DOCKER=1
bash "$PRUNE" > /dev/null 2>&1
check "--keep-storage when --reserved-space is not offered" "grep -q 'builder prune -af --keep-storage 5GB' '$STUB_LOG'"

echo "== prune: docker unreachable is a FAILED unit, and nothing was attempted"
pr_env; export STUB_DOCKER_DOWN=1
bash "$PRUNE" > "$T/down.log" 2>&1; echo $? > "$T/rc"
check "exits nonzero, so OnFailure pages" "[ \"\$(cat '$T/rc')\" != 0 ]"
check "says nothing was pruned" "grep -q 'nothing pruned' '$T/down.log'"
check "no prune command was issued" "! grep -qE 'prune -|rmi' '$STUB_LOG'"

echo "== prune: a dry run names every action and performs none"
pr_env; export PRUNE_DRY_RUN=1
img zfnd/zebra:6.2.0 eeeeeeeeeeee 40
bash "$PRUNE" > "$T/dry.log" 2>&1
check "the build prune is described" "grep -q 'DRY RUN: docker builder prune' '$T/dry.log'"
check "the removal is described" "grep -q 'DRY RUN: docker rmi zfnd/zebra:6.2.0' '$T/dry.log'"
check "and docker was never asked to change anything" "! grep -qE '^docker (builder prune -af|image prune|rmi)' '$STUB_LOG'"
