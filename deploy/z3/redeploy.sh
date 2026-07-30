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

# Three outcomes, because two could not tell "answered no" from "did not answer",
# and only the first of those is evidence about the new build (#229).
#
# A rollback reverts CODE. It cannot fix a corrupt ledger on a volume this script
# never touches, and it cannot fix a wedged read: better-sqlite3 is synchronous, so a
# slow read blocks the event loop and readiness answers LATE rather than answering
# badly (#234, and App's measurement that a 600ms read against a 100ms timeout still
# returns ok at 601ms). Off the request path removed that cause; it did not remove the
# possibility, so a probe that never answers must not be what authorises a revert.
#
# Sets PROBE_REASON to the app's own reason when it gave one, so the caller can tell a
# node that is syncing from a ledger that is unreadable. Read from the SAME response
# rather than a second fetch: two sequential 8s budgets against a slow endpoint is how
# the reason goes missing exactly when it matters most.
# Sets PROBE_STATE and PROBE_REASON rather than echoing, and the caller must NOT wrap
# it in $(...). It used to echo the state and set the reason as a global, which cannot
# work: command substitution runs in a subshell, so the reason was discarded every time
# and every caller saw an empty string. Caught by running it, not by reading it, and it
# is the same shape as everything else this PR is about, a value that looks present and
# is not.
PROBE_STATE=""
PROBE_REASON=""
probe_state() { # $1 = health|ready ; sets PROBE_STATE + PROBE_REASON
  PROBE_STATE=""
  PROBE_REASON=""
  local body rc code
  if [ -n "$FAUCET_URL" ]; then
    # -sS not -fsS: a 503 body carries the reason and -f throws it away.
    body="$(curl -sS --max-time 8 -w '\n%{http_code}' "$FAUCET_URL/api/$1" 2>/dev/null)"
    rc=$?
    # Any nonzero curl status means we did not get an answer: 28 timeout, 7 refused,
    # 6 DNS, 35/56 transport. None of them is the app saying no, so none may look
    # like it.
    if [ "$rc" -ne 0 ]; then
      PROBE_STATE="cannot-tell"
      PROBE_REASON="no answer from /api/$1 (curl $rc)"
      return 0
    fi
    code="${body##*$'\n'}"
    PROBE_REASON="$(printf '%s' "$body" | grep -o '"reason":"[^"]*"' | head -n1 | cut -d'"' -f4)"
    case "$code" in
      2*) PROBE_STATE="ready" ;;
      # An answer with a status is the app speaking, which IS evidence.
      [45]*) PROBE_STATE="not-ready" ;;
      *) PROBE_STATE="cannot-tell" ;;
    esac
    return 0
  fi
  # No published port: fall back to the in-container probe, which cannot separate
  # these three, so it reports the two it can and never invents the third.
  if probe "$1"; then PROBE_STATE="ready"; else PROBE_STATE="cannot-tell"; fi
}

# The reasons a rollback cannot fix, because the cause is not the image. Matched on
# the app's own reason string, which #228 added for exactly this.
reason_is_not_the_code() {
  case "$1" in
    *"ledger unreadable"*) return 0 ;;
    *) return 1 ;;
  esac
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

# Before rolling back, ask WHY once more and read the app's own reason. A rollback
# reverts code, so it is only the right move when the code is a plausible cause (#229).
# NOT $(probe_state ready): that runs in a subshell and the reason would be lost.
probe_state ready
final_state="$PROBE_STATE"
final_reason="$PROBE_REASON"

if [ "$final_state" = "cannot-tell" ]; then
  # We never got an answer. That is not evidence the new build is bad, and reverting on
  # it means a slow or unreachable endpoint can undo a good deploy. Leave the new build
  # running and page, because a faucet nobody can probe is not a faucet anybody should
  # assume is fine.
  log "NOT ROLLING BACK: the readiness probe never answered, so there is no evidence"
  log "  against the new build. A timeout is not a negative, and reverting on one lets a"
  log "  slow endpoint undo a good deploy."
  log "  The new build is still running. Check it and roll back by hand if needed:"
  log "      $0 rollback"
  exit 1
fi

if reason_is_not_the_code "$final_reason"; then
  # The ledger lives on a volume this script never touches, so the previous image
  # would meet exactly the same ledger. Reverting changes nothing except which code is
  # blamed, and exit 2 would say nobody needs paging for a faucet that 500s every claim.
  log "NOT ROLLING BACK: the faucet is not serving, but the cause is DATA, not code"
  log "  reason: $final_reason"
  log "  Volumes are never touched by a deploy, so the previous image would meet the same"
  log "  ledger. A rollback would not fix this, it would only change which build is blamed."
  log "  Fix the ledger, then re-run this script."
  exit 1
fi

log "the new build failed the health gate after ${HEALTH_TIMEOUT}s (reason: ${final_reason:-none given}), rolling back"
if [ -n "$current" ]; then
  do_rollback || die "rollback failed after the health gate, the faucet may be down"
  not_shipped "the new build never became healthy"
fi
die "health gate failed and there is no previous image to roll back to, the faucet is down"
