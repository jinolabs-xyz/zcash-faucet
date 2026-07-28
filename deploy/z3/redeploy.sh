#!/usr/bin/env bash
# One command to ship a new faucet build, with a health gate and an
# automatic rollback when the new one does not come up.
#
#   redeploy.sh              pull, build, swap, verify, roll back on failure
#   redeploy.sh --no-pull    build and swap what is already checked out
#   redeploy.sh rollback     go back to the previous image by hand
#   redeploy.sh status       what is running now and what is available to roll back to
#
# Exit codes matter for anything scripting this, and the split is about
# whether to wake someone:
#   0  the new build is live and healthy
#   2  the change did NOT ship and the faucet is serving anyway, either
#      because nothing was swapped (bad pull, failed build) or because the
#      rollback put the old build back. Nobody needs to be paged for this.
#   1  the faucet may be DOWN: the rollback itself failed, or there was no
#      previous image to go back to. This one is a page.
#
# The safety property: the previously running image is tagged
# zcash-faucet:previous BEFORE anything is rebuilt, so there is always
# something to go back to that is known to have served traffic. If the new
# build fails to build, fails to start, or fails the health gate, the old
# image is put back and the faucet is serving again before this script exits.
#
# What "healthy" means here matters. /api/health is liveness (is the process
# answering) and is required unconditionally. /api/ready is "can it serve a
# drip", which is legitimately false during a sync or a refill, so it is only
# required if the faucet WAS ready before the deploy. That way a deploy can
# never quietly turn a serving faucet into a non-serving one, but it also
# does not refuse to ship while the node is still syncing.
#
# Volumes are never touched. The rate-limit ledger and the wallet outlive
# every deploy, and a rollback rolls back code, not data.
set -uo pipefail

REPO_DIR="${REDEPLOY_REPO_DIR:-/opt/zcash-faucet}"
OVERLAY_DIR="${REDEPLOY_OVERLAY_DIR:-$REPO_DIR/deploy/z3}"
COMPOSE_FILE="${REDEPLOY_COMPOSE_FILE:-docker-compose.faucet.yml}"
IMAGE="${REDEPLOY_IMAGE:-zcash-faucet:latest}"
PREVIOUS_TAG="${REDEPLOY_PREVIOUS_TAG:-zcash-faucet:previous}"
# Empty by default: the app port is expose-only, so there is no URL the host
# can reach. Probing happens inside the container unless you set one.
FAUCET_URL="${REDEPLOY_FAUCET_URL:-}"
HEALTH_TIMEOUT="${REDEPLOY_HEALTH_TIMEOUT:-120}"   # seconds to become live
HEALTH_INTERVAL="${REDEPLOY_HEALTH_INTERVAL:-3}"
Z3_NETWORK_NAME="${Z3_NETWORK_NAME:-z3-testnet}"

log() { echo "$(date -u +%FT%TZ) redeploy: $*"; }
# die is for the faucet-may-be-down cases only, because exit 1 is what a
# pager should react to.
die() { log "ERROR: $*"; exit 1; }
# The change did not ship but the faucet is serving. Distinct code so
# automation cannot read it as a successful deploy, and so a broken build does
# not wake anyone at 3am for a healthy faucet.
not_shipped() {
  log "DEPLOY FAILED: $1"
  log "The faucet is serving. Your change did NOT ship."
  exit 2
}

command -v docker >/dev/null || not_shipped "docker is not installed, nothing was attempted"

compose() { ( cd "$OVERLAY_DIR" && Z3_NETWORK_NAME="$Z3_NETWORK_NAME" \
                FAUCET_DOMAIN="${FAUCET_DOMAIN:-$(cat /etc/faucet-domain 2>/dev/null || true)}" \
                docker compose -f "$COMPOSE_FILE" "$@" ); }

image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }

# Probes from inside the container, mirroring the compose healthcheck, because
# the app port is expose-only and Caddy redirects :80 once a domain is set.
probe() { # $1 = health|ready, returns 0 when it answers 200
  if [ -n "$FAUCET_URL" ]; then
    curl -fsS --max-time 8 "$FAUCET_URL/api/$1" >/dev/null 2>&1
    return $?
  fi
  compose exec -T faucet node -e \
    "fetch('http://127.0.0.1:3000/api/$1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

# True when the probe mechanism itself cannot run, which is not the same as
# the faucet being unhealthy and must never be reported as such.
probe_usable() {
  [ -n "$FAUCET_URL" ] && return 0
  compose exec -T faucet node -e 'process.exit(0)' >/dev/null 2>&1
}

# Liveness is required. Readiness is required only when it held before, so a
# deploy cannot silently downgrade a serving faucet, and is not blocked by a
# node that is still syncing.
wait_healthy() { # $1 = 1 when readiness is also required
  local want_ready="$1" deadline=$((SECONDS + HEALTH_TIMEOUT)) live=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    if probe health; then
      live=1
      if [ "$want_ready" != "1" ]; then return 0; fi
      if probe ready; then return 0; fi
    fi
    sleep "$HEALTH_INTERVAL"
  done
  [ "$live" = "1" ] && log "app is live but never became ready within ${HEALTH_TIMEOUT}s"
  return 1
}

is_ready_now() { probe ready; }

# Puts the previous image back and waits for it to answer. Returns nonzero
# when there is nothing to go back to or it will not come up, which is the
# case that needs a human rather than a retry.
do_rollback() {
  local prev
  prev="$(image_id "$PREVIOUS_TAG")"
  [ -n "$prev" ] || { log "ERROR: no $PREVIOUS_TAG image to roll back to"; return 1; }
  log "rolling back to $PREVIOUS_TAG ($prev)"
  docker tag "$PREVIOUS_TAG" "$IMAGE" || { log "ERROR: could not retag $PREVIOUS_TAG"; return 1; }
  compose up -d --no-build faucet || { log "ERROR: could not start the rolled-back image"; return 1; }
  # Liveness only: the previous build was serving, and if the node has since
  # gone un-ready that is not this image's fault.
  if wait_healthy 0; then
    log "rolled back and live"
    return 0
  fi
  log "ERROR: rolled back but the faucet is not answering, this needs a human"
  return 1
}

case "${1:-deploy}" in
  status)
    cur="$(image_id "$IMAGE")"; prev="$(image_id "$PREVIOUS_TAG")"
    log "running:  ${cur:-none} ($IMAGE)"
    log "rollback: ${prev:-none} ($PREVIOUS_TAG)"
    [ -n "$prev" ] || log "no rollback target yet, the first redeploy creates one"
    if is_ready_now; then log "faucet is READY"; else log "faucet is NOT ready right now"; fi
    exit 0
    ;;
  rollback)
    do_rollback || exit 1
    exit 0
    ;;
  deploy|--no-pull) : ;;
  *) not_shipped "unknown argument '${1:-}' (usage: redeploy.sh [--no-pull|rollback|status])" ;;
esac

[ -d "$OVERLAY_DIR" ] || not_shipped "no overlay dir at $OVERLAY_DIR (set REDEPLOY_OVERLAY_DIR)"

# Was it serving before? That decides how strict the gate is afterwards.
want_ready=0
if is_ready_now; then
  want_ready=1
  log "faucet is ready now, so the new build must be ready too before this is called a success"
else
  log "faucet is not ready right now (syncing or refilling), so the gate is liveness only"
fi

# Snapshot the current image FIRST. Without this there is nothing to go back
# to, and a broken build would leave the box with no known-good faucet.
current="$(image_id "$IMAGE")"
if [ -n "$current" ]; then
  docker tag "$IMAGE" "$PREVIOUS_TAG" \
    || not_shipped "could not tag the current image as $PREVIOUS_TAG, refusing to build without a rollback target"
  log "current image $current tagged $PREVIOUS_TAG for rollback"
else
  log "no existing $IMAGE, this is a first deploy and there is nothing to roll back to"
fi

if [ "${1:-deploy}" != "--no-pull" ]; then
  log "pulling the latest code in $REPO_DIR"
  before="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  git -C "$REPO_DIR" pull --ff-only 2>&1 | sed 's/^/    /' \
    || not_shipped "git pull failed, nothing has changed on the box"
  after="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  log "code: $before -> $after"
fi

# A build failure is the cheapest failure: nothing has been swapped yet.
log "building the new image"
if ! compose build faucet 2>&1 | tail -n 20 | sed 's/^/    /'; then
  not_shipped "build failed, the running faucet was left alone"
fi

log "starting the new image"
if ! compose up -d faucet 2>&1 | sed 's/^/    /'; then
  log "the new image would not start, rolling back"
  do_rollback || die "rollback failed after the new image would not start, the faucet may be down"
  not_shipped "the new image would not start"
fi

if wait_healthy "$want_ready"; then
  new="$(image_id "$IMAGE")"
  log "deployed and healthy: $new"
  exit 0
fi

# A gate failure only means something when the probe could actually run.
if ! probe_usable; then
  log "NOT VERIFIED: could not probe the app at all (no $FAUCET_URL and docker compose exec failed)"
  log "The new build is running and may be fine. Nothing was rolled back."
  log "Set REDEPLOY_FAUCET_URL to something reachable and re-run to get a real verdict."
  exit 2
fi

log "the new build failed the health gate after ${HEALTH_TIMEOUT}s, rolling back"
if [ -n "$current" ]; then
  do_rollback || die "rollback failed after the health gate, the faucet may be down"
  not_shipped "the new build never became healthy"
fi
die "health gate failed and there is no previous image to roll back to, the faucet is down"
