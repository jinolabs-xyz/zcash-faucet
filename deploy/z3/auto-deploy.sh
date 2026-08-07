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

rc=0
changed="$(git diff --name-only "$LOCAL" "$REMOTE")"

# Two questions, not one. The old filter asked only "does the web app need a
# rebuild", and treated a no as "nothing to do".
app=0
ops=0
printf '%s\n' "$changed" | grep -qE '^(src/|public/|package|Dockerfile|next\.config|tsconfig|deploy/z3/(docker-compose|Caddyfile))' && app=1
printf '%s\n' "$changed" | grep -qE '^deploy/z3/.*\.(sh|service|timer|socket)$' && ops=1
# THE MINER IS A COMPILED BINARY AND NOTHING REBUILT IT (#412).
#
# install-ops syncs scripts and units. It cannot rebuild a binary and does not try, so a
# commit touching miner source left /opt/faucet/zcash-testnet-miner older than its
# sources - which is exactly what box-report compares - and the box sat at 40 of 41 with
# `minerBinary: stale` until a human logged in and ran two commands from MINING.md.
#
# It was not theoretical. #402 merged 2026-08-04 17:32 UTC and the next live-smoke run
# went red and stayed red for two days. The external monitor was correct the whole time
# and unactionable, which taught at least one reader to treat it as noise.
miner=0
printf '%s\n' "$changed" | grep -qE '^deploy/z3/miner/(src/|Cargo\.(toml|lock))' && miner=1

git reset -q --hard "origin/$BRANCH"
log "advanced to $(git rev-parse --short HEAD) (app=$app ops=$ops miner=$miner)"

# BUILT ON THE BOX, DELIBERATELY, AND THE HOUSE RULE IS NOT BEING BROKEN.
#
# SNAPSHOTS.md says the Crosslink node is built in a container and never on the box, and
# that rule is right FOR THAT BUILD: zebra takes hours and would starve the node it is
# meant to serve. This one takes 41 seconds, measured on this box while cTAZ was mining
# at its 250% quota. Shipping an artefact instead would mean a release asset or a
# registry, which is a fetch path, a credential and a storage bill for a 3 MB file that
# rebuilds in under a minute. The owner's constraint is no new hosting; this respects it.
#
# Niced and ioniced so the node keeps its CPU, and it only runs when miner source moved,
# which is rare.
if [ "$miner" = "1" ]; then
  # cargo is not on a non-login shell's PATH here, which is its own small evidence that
  # this was never a routine step. Found by watching a "successful" build compile nothing.
  CARGO="${MINER_CARGO:-/root/.cargo/bin/cargo}"
  if [ ! -x "$CARGO" ]; then
    log "ERROR: miner source changed but no cargo at $CARGO, so the binary stays stale"
    miner_rc=1
  elif ! nice -n 19 ionice -c3 "$CARGO" build --release \
        --manifest-path "$REPO_DIR/deploy/z3/miner/Cargo.toml" >/dev/null 2>&1; then
    log "ERROR: the miner failed to build, keeping the binary that is already installed"
    miner_rc=1
  else
    # RENAME, NEVER cp ONTO THE RUNNING FILE. `cp` over a live binary gives "Text file
    # busy" and does nothing, and the restart afterwards then relaunches the OLD build
    # while every status signal reads healthy. I shipped that mistake by hand an hour
    # before writing this; only comparing the sha caught it.
    built="$REPO_DIR/deploy/z3/miner/target/release/zcash-testnet-miner"
    if install -m 755 "$built" "$INSTALL_DIR/.zcash-testnet-miner.new" \
       && mv -f "$INSTALL_DIR/.zcash-testnet-miner.new" "$INSTALL_DIR/zcash-testnet-miner"; then
      systemctl restart zcash-testnet-miner 2>/dev/null \
        || log "ERROR: new miner installed but the restart failed, it is still on the old one"
      log "miner rebuilt and restarted ($(sha256sum "$INSTALL_DIR/zcash-testnet-miner" | cut -c1-12))"
      miner_rc=0
    else
      log "ERROR: could not install the rebuilt miner"
      miner_rc=1
    fi
  fi
else
  miner_rc=0
fi

if [ "$ops" = "1" ]; then
  # Install the installer first, then run the INSTALLED copy, so /opt/faucet is
  # self-consistent afterwards and audit-drift has something to compare.
  install -m 755 "$REPO_DIR/deploy/z3/install-ops.sh" "$INSTALL_DIR/install-ops.sh" \
    || { log "ERROR: could not install install-ops.sh"; exit 1; }
  # THE SOURCE IS PASSED EXPLICITLY. Running the installed copy with no argument made
  # its source directory the DESTINATION, so it globbed /opt/faucet, copied files onto
  # themselves, could not see anything missing, and exited 0. That is why 19 of 25
  # required files were never installed. install-ops.sh now refuses that case outright,
  # and this passes the repo so the refusal is never reached in normal operation.
  "$INSTALL_DIR/install-ops.sh" "$REPO_DIR/deploy/z3" \
    || { log "ERROR: install-ops FAILED, so the box is not at spec. Not treating this as a warning."; rc=1; }
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
  app_rc=$?
  # A HEALTHY REBUILD MUST NOT ERASE A FAILED OPS INSTALL.
  #
  # This used to be `exit $?`, which is redeploy's status and discards rc from the ops
  # install above. So on a commit touching BOTH -- ops install fails, rebuild succeeds --
  # the script exited 0. The timer reported success, the site was fine, and the box was
  # silently not at spec. That is precisely what the closing comment below forbids,
  # defeated by an earlier exit, and it is the shape that let 19 missing files stay
  # invisible: a real failure with a green signal in front of it.
  #
  # redeploy's own code wins when redeploy failed, because it spends 0/1/2 to distinguish
  # a broken deploy from an unverified one and that distinction decides who gets paged.
  # Otherwise a failed ops install still fails the run.
  [ "$app_rc" -ne 0 ] && exit "$app_rc"
  # A failed miner rebuild leaves the box at 40 of 41 and the live probe red, which is
  # the state this whole change exists to end. It must not exit 0 just because the app
  # and ops halves went fine. shellcheck caught that this variable was set and never
  # read, which would have made the rebuild's failure path decorative.
  [ "$rc" -eq 0 ] && [ "$miner_rc" -ne 0 ] && exit "$miner_rc"
  exit "$rc"
fi

[ "$ops" = "1" ] || log "main moved but touched neither the app nor ops, nothing to install"

# A failed install must not exit 0. The timer's own status is the only signal anyone
# sees for this unit, and reporting success for a box that is not at spec is how the
# missing 19 files stayed invisible.
[ "$rc" -eq 0 ] && [ "$miner_rc" -ne 0 ] && exit "$miner_rc"
exit "$rc"
