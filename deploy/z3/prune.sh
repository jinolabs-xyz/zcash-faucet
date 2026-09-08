#!/usr/bin/env bash
# Reclaims the Docker disk the deploy path leaves behind, on a timer.
#
# WHY. Nothing on the box pruned anything. Every deploy builds an image and every build
# leaves a cache generation; on 2026-09-08 that was 53.6 GB of build cache with zero
# active entries and 377 dangling image layers, on the root disk that also holds the
# chain, the wallet and the backups. The 82%-full event that took the faucet down once was
# the first lap of that, not a one-off. At 100% the exports die, backups truncate, sqlite
# goes read-only and dockerd wedges, in that order or any other.
#
# WHAT IT DOES, and only this: build cache down to PRUNE_KEEP_BUILD_CACHE (5GB), and
# dangling layers (untagged, referenced by nothing). Those two are the whole 53 GB.
#
# WHAT IT NEVER TOUCHES:
#   volumes      the chain, the wallet, faucet_data. No `docker volume prune` here, and a
#                test asserts the word never reaches docker.
#   containers   stopped or running. redeploy.sh owns those.
#   TAGGED IMAGES, any of them. The first version removed tagged images "unused for 30
#                days" and its review found three ways that deletes the wrong thing:
#                Docker's CreatedAt is the UPSTREAM build time, so an image pulled an hour
#                ago for tomorrow's upgrade already reads months old; the helper images
#                the heal scripts `docker run --rm` (alpine, busybox, curl) are held by no
#                container at 04:10 and would go too, putting a Docker Hub pull on the 3am
#                auto-heal path; and `docker ps` has no {{.ImageID}}, so the "in use by id"
#                guard was supplied entirely by the test double. A stale zfnd/zebra tag
#                after an upgrade costs ~400 MB once and is listed below for a human.
#
# EXIT CODE IS THE ALERT. The unit carries OnFailure=, so a build-cache prune that fails
# (a flag this docker does not know, a wedged daemon) exits non-zero and pages. A prune
# that quietly reclaims nothing every night is the register entry this script exists to
# close, so it is not allowed to look like success.
set -uo pipefail

KEEP_BUILD="${PRUNE_KEEP_BUILD_CACHE:-5GB}"
DRY="${PRUNE_DRY_RUN:-0}"

log() { echo "$(date -u +%FT%TZ) prune: $*"; }
run() { # a docker command that changes something; DRY describes it instead
  if [ "$DRY" = 1 ]; then echo "would run: docker $*"; return 0; fi
  docker "$@"
}
# Bounded: `docker system df` walks every layer and on a full box that is not instant. A
# usage line is context, and context must not be what eats the unit's start timeout.
usage() {
  timeout 120 docker system df --format '{{.Type}}: {{.Size}} ({{.Reclaimable}} reclaimable)' 2>/dev/null | tr '\n' ' ' \
    || echo "(docker system df did not answer in 120s)"
}

if ! docker version >/dev/null 2>&1; then
  log "ERROR: docker is not reachable, nothing pruned"
  exit 1
fi
log "before: $(usage)"
rc=0

# 1. Build cache. Docker 29 renamed --keep-storage to --reserved-space; asking the binary
#    beats pinning a flag that one upgrade turns into "unknown flag". If the guess is still
#    wrong the command fails, and that failure is the page.
flag="--keep-storage"
docker builder prune --help 2>&1 | grep -q -- '--reserved-space' && flag="--reserved-space"
if out="$(run builder prune -af "$flag" "$KEEP_BUILD" 2>&1)"; then
  log "build cache: $(printf '%s\n' "$out" | tail -n1)"
else
  log "ERROR: builder prune failed: $(printf '%s\n' "$out" | tail -n1)"
  rc=1
fi

# 2. Dangling layers: untagged, referenced by nothing, the residue of every rebuild. NOT -a:
#    -a would take every tagged image no container holds, the rollback image first.
if out="$(run image prune -f 2>&1)"; then
  log "dangling images: $(printf '%s\n' "$out" | tail -n1)"
else
  log "ERROR: image prune failed: $(printf '%s\n' "$out" | tail -n1)"
  rc=1
fi

# 3. Tagged images no container holds: LISTED as information, never removed and never
#    recommended for removal. The rollback image is held by no container BY DESIGN, and
#    the heal scripts' helper images are held by none between runs; a line that read
#    "remove by hand if unwanted" nominated exactly those. Our own tags are left off the
#    list, and the wording says why the rest are still there.
in_use="$(docker ps -a --format '{{.Image}}' 2>/dev/null)"
unused=""
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  case "$ref" in *'<none>'*|zcash-faucet:*) continue ;; esac
  printf '%s\n' "$in_use" | grep -qxF -- "$ref" || unused="$unused $ref"
done < <(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null)
if [ -n "$unused" ]; then
  log "for the record, tagged images no container holds right now (kept; heal helpers and pre-pulled upgrades belong here):${unused}"
fi

log "after: $(usage)"
exit "$rc"
