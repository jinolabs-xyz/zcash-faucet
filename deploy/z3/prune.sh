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
# WHAT IT NEVER TOUCHES, and each is a rule rather than an omission:
#   volumes      the chain, the wallet, faucet_data. `docker volume prune` is not here and a
#                test asserts it never appears.
#   containers   stopped containers are redeploy.sh's business (rollback keeps one).
#   zcash-faucet:previous  the rollback image. `docker image prune -a` would take it the
#                first week without a deploy, which is exactly when a rollback is needed.
#   anything a container is using, by tag OR by id (a retagged image shows as an id).
#   anything the stack's pin file names (Z3_*_IMAGE in .env.testnet), so an image pulled
#                ahead of an upgrade survives to the upgrade.
#
# WHAT IT DOES: build cache down to PRUNE_KEEP_BUILD_CACHE (5GB), dangling layers, and
# tagged images nobody uses that are older than PRUNE_IMAGE_AGE_DAYS (30). The old
# zfnd/zebra:6.2.0 after an upgrade is the case for the last one.
#
# Runs under faucet-prune.timer, daily. Exit non-zero only when docker itself is
# unreachable, which pages through OnFailure=; a single image that would not delete is a
# WARN line, because a prune that fails on one layer must still do the rest.
set -uo pipefail

KEEP_BUILD="${PRUNE_KEEP_BUILD_CACHE:-5GB}"
IMAGE_AGE_DAYS="${PRUNE_IMAGE_AGE_DAYS:-30}"
KEEP_IMAGES="${PRUNE_KEEP_IMAGES:-zcash-faucet:latest zcash-faucet:previous}"
PIN_FILE="${PRUNE_PIN_FILE:-/opt/zcash-faucet/deploy/z3-stack/.env.testnet}"
DRY="${PRUNE_DRY_RUN:-0}"

log() { echo "$(date -u +%FT%TZ) prune: $*"; }
run() { # a docker command that changes something; DRY logs it instead
  if [ "$DRY" = 1 ]; then log "DRY RUN: docker $*"; return 0; fi
  docker "$@"
}
usage() { docker system df --format '{{.Type}}: {{.Size}} ({{.Reclaimable}} reclaimable)' 2>/dev/null | tr '\n' ' '; }

if ! docker version >/dev/null 2>&1; then
  log "ERROR: docker is not reachable, nothing pruned"
  exit 1
fi
log "before: $(usage)"
rc=0

# 1. Build cache. Docker 29 renamed --keep-storage to --reserved-space; asking the binary
#    beats pinning a flag that one upgrade turns into "unknown flag" and a failed unit.
flag="--keep-storage"
docker builder prune --help 2>&1 | grep -q -- '--reserved-space' && flag="--reserved-space"
run builder prune -af "$flag" "$KEEP_BUILD" | tail -n1 | sed 's/^/  build cache: /' || { log "WARN: builder prune failed"; rc=0; }

# 2. Dangling layers: untagged, unreferenced, the residue of every rebuild. NOT -a.
run image prune -f | tail -n1 | sed 's/^/  dangling images: /' || log "WARN: image prune failed"

# 3. Tagged images nobody uses, past the age. Protected set first, then age.
protected="$KEEP_IMAGES"
if [ -r "$PIN_FILE" ]; then
  pins="$(grep -E '^[A-Za-z0-9_]*_IMAGE=' "$PIN_FILE" | cut -d= -f2- | tr -d "\"'" | tr '\n' ' ')"
  protected="$protected $pins"
fi
in_use_refs="$(docker ps -a --format '{{.Image}}' 2>/dev/null)"
in_use_ids="$(docker ps -a --format '{{.ImageID}}' 2>/dev/null | sed 's/^sha256://' | cut -c1-12)"
now="$(date -u +%s)"
removed=0
while IFS=$'\t' read -r ref id created; do
  [ -n "$ref" ] || continue
  case "$ref" in *'<none>'*) continue ;; esac
  keep=""
  for p in $protected; do [ "$ref" = "$p" ] && keep="protected"; done
  [ -z "$keep" ] && printf '%s\n' "$in_use_refs" | grep -qxF -- "$ref" && keep="in use"
  [ -z "$keep" ] && printf '%s\n' "$in_use_ids" | grep -qxF -- "$(printf '%s' "$id" | sed 's/^sha256://' | cut -c1-12)" && keep="in use by id"
  if [ -z "$keep" ]; then
    # CreatedAt looks like "2026-08-11 09:12:33 +0000 UTC"; GNU date reads it without the zone name.
    created_s="$(date -u -d "${created% *}" +%s 2>/dev/null || echo "$now")"
    age_days=$(( (now - created_s) / 86400 ))
    [ "$age_days" -ge "$IMAGE_AGE_DAYS" ] || keep="only ${age_days}d old"
  fi
  if [ -n "$keep" ]; then
    continue
  fi
  log "removing unused image $ref (${age_days}d old)"
  if out="$(run rmi "$ref" 2>&1)"; then
    removed=$((removed + 1))
    [ "$DRY" = 1 ] && printf '%s\n' "$out"
  else
    log "WARN: could not remove $ref: $(printf '%s\n' "$out" | tail -n1)"
  fi
done < <(docker images --format $'{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}' 2>/dev/null)
log "unused tagged images removed: $removed"

log "after: $(usage)"
exit "$rc"
