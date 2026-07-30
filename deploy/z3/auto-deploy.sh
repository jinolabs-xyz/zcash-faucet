#!/usr/bin/env bash
# Pulls main and acts on what changed. This was previously ONLY at
# /opt/faucet/auto-deploy.sh, untracked, so the script deciding what reaches
# production was unreviewed and invisible to audit-drift. It is here now (#181).
#
# Two bugs it used to have, both of which made merged ops work dead on the box:
#
#   1. The app-affecting filter did not match deploy/z3/*.sh or the units, so a
#      commit touching only watchdog.sh took the else branch. The checkout
#      advanced and nothing was installed, and the log said "nothing
#      app-affecting", true of the web app and false of the box's supervision.
#   2. Even the taken branch installed exactly one file, redeploy.sh.
#
# Now: ops changes install ops, app changes rebuild the app, and a commit that
# touches both does both.
set -uo pipefail

REPO_DIR="${AUTODEPLOY_REPO_DIR:-/opt/zcash-faucet}"
INSTALL_DIR="${AUTODEPLOY_INSTALL_DIR:-/opt/faucet}"
BRANCH="${AUTODEPLOY_BRANCH:-main}"

log() { echo "$(date -u +%FT%TZ) auto-deploy: $*"; }

cd "$REPO_DIR" || { log "ERROR: no repo at $REPO_DIR"; exit 1; }

git fetch -q origin "$BRANCH" || { log "ERROR: fetch failed, nothing changed"; exit 1; }
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
[ "$LOCAL" = "$REMOTE" ] && { log "already at $(git rev-parse --short HEAD), nothing to do"; exit 0; }

changed="$(git diff --name-only "$LOCAL" "$REMOTE")"

# Two questions, not one. The old filter asked only "does the web app need a
# rebuild", and treated a no as "nothing to do".
app=0
ops=0
printf '%s\n' "$changed" | grep -qE '^(src/|public/|package|Dockerfile|next\.config|tsconfig|deploy/z3/(docker-compose|Caddyfile))' && app=1
printf '%s\n' "$changed" | grep -qE '^deploy/z3/.*\.(sh|service|timer)$' && ops=1

git reset -q --hard "origin/$BRANCH"
log "advanced to $(git rev-parse --short HEAD) (app=$app ops=$ops)"

if [ "$ops" = "1" ]; then
  # Install the installer first, then run the INSTALLED copy, so /opt/faucet is
  # self-consistent afterwards and audit-drift has something to compare.
  install -m 755 "$REPO_DIR/deploy/z3/install-ops.sh" "$INSTALL_DIR/install-ops.sh" \
    || { log "ERROR: could not install install-ops.sh"; exit 1; }
  "$INSTALL_DIR/install-ops.sh" || log "WARNING: install-ops reported a problem, see above"
fi

# THIS SCRIPT UPDATES ITSELF FOR THE NEXT RUN AND DOES NOT RE-EXEC.
#
# Bash reads a script lazily as it executes, so overwriting the file the current
# shell is still reading can make the interpreter resume at a byte offset that now
# lands mid-line in different text. One cycle of lag is the cheap, safe version:
# the copy installed here is what runs next time. install-ops.sh deliberately
# skips itself for the same reason, which is why this copy is done here.
if printf '%s\n' "$changed" | grep -qx 'deploy/z3/auto-deploy.sh'; then
  install -m 755 "$REPO_DIR/deploy/z3/auto-deploy.sh" "$INSTALL_DIR/auto-deploy.sh" \
    && log "auto-deploy.sh updated, the new copy runs on the NEXT tick, not this one"
fi

if [ "$app" = "1" ]; then
  "$INSTALL_DIR/redeploy.sh"
  exit $?
fi

[ "$ops" = "1" ] || log "main moved but touched neither the app nor ops, nothing to install"
