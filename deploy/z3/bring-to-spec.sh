#!/usr/bin/env bash
# ONE COMMAND THAT BRINGS A BOX TO SPEC, and refuses rather than reporting success.
#
# Bringing the box current took handing someone four different commands and getting two
# of them wrong. That is the maintainability problem, not any single script.
#
# This composes what already exists rather than reimplementing it. Each step is a script
# that already asserts its own end state (programme C), so this adds one thing they
# cannot: a check that the box as a WHOLE matches the repo, made after everything has run.
#
#   1. install ops    install-ops.sh, which also enables what enabled-units declares
#   2. build the miner  nothing automated this, which is why /opt/faucet held a four-day-old
#                       binary writing no heartbeat while box-report read 28 of 28
#   3. report         box-report.sh, so the external gate has something fresh to read
#   4. PROVE IT       re-read the report and refuse unless the box actually matches
#
# WHAT IT DELIBERATELY DOES NOT DO. It does not deploy the app: redeploy.sh owns that and
# has its own rollback. It does not touch the z3 stack: deploy.sh owns that and it is the
# thing that rewrites the wallet config. It does not start mining. Composing those in
# would make one command that can take the site down, and the point of this one is that
# it is safe to run repeatedly at any time.
#
# Safe to re-run by construction: every step underneath is idempotent, and a second run
# with nothing to do says so rather than reinstalling.
#
# EXIT CODES, matching redeploy.sh rather than quietly differing from it:
#   0  the box is at spec, and that was checked rather than assumed
#   1  KNOWN-BAD. The box is definitely not at spec, and what is wrong is named.
#   2  CANNOT-VERIFY. The box may well be at spec; this run is not able to say so.
#
# The distinction is the three-state discipline the rest of the stack already keeps: a run
# that could not read the report and a run that read it and found the box short are
# different facts, and collapsing them into one code throws away the more useful one. This
# script already made that distinction in its PROSE (UNVERIFIED vs FAILED) and then sent
# both to the same exit 1. Known-bad outranks cannot-verify when both happen, because a
# definite fault beats an unanswered question for what somebody should do next.
set -uo pipefail

REPO_DIR="${SPEC_REPO_DIR:-/opt/zcash-faucet}"
SRC="${SPEC_SOURCE_DIR:-$REPO_DIR/deploy/z3}"
INSTALL_DIR="${SPEC_INSTALL_DIR:-/opt/faucet}"
MINER_BIN="${SPEC_MINER_BIN:-$INSTALL_DIR/zcash-testnet-miner}"
CARGO="${SPEC_CARGO:-cargo}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

log() { echo "$(date -u +%FT%TZ) bring-to-spec: $*"; }
die() { log "ERROR: $*"; exit 1; }

# Refuse a source that is not the ops tree, for the same reason install-ops does: a wrong
# path installs nothing and reports success, which is how 19 of 25 files stayed missing.
[ -d "$SRC" ] || die "no ops source at $SRC (set SPEC_SOURCE_DIR)"
ls "$SRC"/*.sh >/dev/null 2>&1 || die "no *.sh in $SRC, so that is not the ops source directory"

steps_run=0
failed=""      # known-bad: something is definitely wrong
unverified=""  # cannot-verify: this run is not able to say either way

# ── 1. ops scripts, units, and the enablement the repo declares ──────────────────
log "installing ops from $SRC"
if [ "$DRY" = "1" ]; then
  bash "$SRC/install-ops.sh" --dry-run "$SRC" || failed="$failed install-ops"
else
  bash "$SRC/install-ops.sh" "$SRC" || failed="$failed install-ops"
fi
steps_run=$((steps_run + 1))

# ── 2. the compiled miner, which nothing automated ───────────────────────────────
# install-ops copies *.sh and units. A compiled binary is neither, so the miner on the
# box stayed the build someone last made by hand: on 2026-07-31 that was four days old and
# wrote no heartbeat, while the integrity count read 28 of 28 because it could not see the
# binary either.
#
# Rebuilt only when the sources are newer, using the same question box-report asks, so a
# re-run does not spend three minutes of CPU proving nothing changed.
miner_src="$SRC/miner"
if [ ! -d "$miner_src" ]; then
  log "no miner sources at $miner_src, skipping the build"
elif ! command -v "$CARGO" >/dev/null 2>&1; then
  # Not silent, and not fatal on its own: a box that does not mine is a box that does not
  # mine, but it must not read as being at spec.
  log "NOTE: no cargo on this host, so the miner binary cannot be built or checked"
  unverified="$unverified miner-build(no-cargo)"
else
  need_build=1
  if [ -f "$MINER_BIN" ]; then
    newest=0
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      m="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
      [ "$m" -gt "$newest" ] && newest="$m"
    done <<EOF
$(find "$miner_src" -type f \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \) 2>/dev/null)
EOF
    bin_m="$(stat -c %Y "$MINER_BIN" 2>/dev/null || echo 0)"
    [ "$newest" -gt 0 ] && [ "$bin_m" -ge "$newest" ] && need_build=0
  fi
  if [ "$need_build" = "0" ]; then
    log "miner binary is newer than its sources, no rebuild needed"
  elif [ "$DRY" = "1" ]; then
    log "would build the miner and install it to $MINER_BIN"
  else
    log "building the miner (this takes a few minutes on a small box)"
    if ( cd "$miner_src" && "$CARGO" build --release ) >/dev/null 2>&1; then
      built="$miner_src/target/release/zcash-testnet-miner"
      if [ -f "$built" ]; then
        install -m 755 "$built" "$MINER_BIN" \
          && log "installed the miner binary to $MINER_BIN" \
          || failed="$failed miner-install"
      else
        # cargo exiting 0 without producing the binary is the shape worth naming: the
        # build "succeeded" and there is nothing to install.
        failed="$failed miner-build(no-binary-produced)"
        log "ERROR: cargo exited 0 but $built does not exist"
      fi
    else
      failed="$failed miner-build"
      log "ERROR: the miner build failed, run it by hand in $miner_src to see why"
    fi
  fi
  steps_run=$((steps_run + 1))
fi

# ── 3. publish what the box now has ──────────────────────────────────────────────
if [ "$DRY" = "1" ]; then
  log "would refresh the box integrity report"
else
  log "refreshing the box integrity report"
  # A report that will not run leaves us unable to answer, not knowing the answer is bad.
  bash "$INSTALL_DIR/box-report.sh" >/dev/null 2>&1 \
    || bash "$SRC/box-report.sh" >/dev/null 2>&1 \
    || unverified="$unverified box-report"
fi
steps_run=$((steps_run + 1))

# ── 4. PROVE IT, which is the only part that is new ──────────────────────────────
# Every step above asserts its own end state. None of them can answer "is the box at
# spec", because each sees only its own slice. This reads the report the box just
# published and refuses unless it says everything the repo requires is present.
#
# Deliberately re-reading the published artifact rather than trusting the steps: that is
# the same file the external CI gate reads, so agreeing with it here means the two cannot
# disagree later.
if [ "$DRY" = "1" ]; then
  log "dry run: no post-condition, because nothing was changed"
  log "done (dry run): $steps_run step(s) would run"
  exit 0
fi

report="${SPEC_REPORT:-/var/lib/docker/volumes/z3_faucet_data/_data/box-integrity.json}"
if [ ! -f "$report" ]; then
  log "POST-CONDITION UNVERIFIED: no integrity report at $report."
  log "  The box may well be at spec; this run cannot say so, and saying so anyway is the"
  log "  failure mode this whole programme exists to remove."
  unverified="$unverified post-condition(no-report)"
else
  exp="$(sed -n 's/.*"expected":\([0-9]*\).*/\1/p' "$report" | head -1)"
  got="$(sed -n 's/.*"present":\([0-9]*\).*/\1/p' "$report" | head -1)"
  nen="$(sed -n 's/.*"notEnabled":\([0-9]*\).*/\1/p' "$report" | head -1)"
  mnr="$(sed -n 's/.*"minerBinary":"\([a-z]*\)".*/\1/p' "$report" | head -1)"
  mnr="${mnr:-unknown}"

  # THE MINER BINARY IS IN THE GATE, not merely printed next to it.
  #
  # Found in review (SDE-App, #319). This block read minerBinary into `mnr` and then only
  # logged it: the condition was present-vs-expected and notEnabled. So a report saying the
  # binary was STALE exited 0 with "box is at spec", and the word `verified` appeared on the
  # same line as the word `stale`. That is the four-day-old-binary incident reproduced
  # exactly, by the one command written to prevent it, and it is the single condition
  # programme B was opened to fix.
  #
  # The five states box-report can emit are not one question, so they do not get one answer:
  #   current    built after the last source change            -> good
  #   stale      a merged change nobody compiled                -> KNOWN-BAD, this is the incident
  #   absent     sources exist, no binary was installed         -> KNOWN-BAD
  #   unknown    dirty tree, or mtime mode with an older binary -> CANNOT-VERIFY, box-report
  #              says so itself rather than guessing, and this must not launder that into a pass
  #   untracked  no miner sources in the repo at all            -> not applicable; box-report
  #              does not even add it to `expected`, so failing on it would fail every box
  #              that legitimately has no miner
  # A report with no minerBinary field at all reads as `unknown` and so fails closed: an
  # older box-report that predates the field must not silently satisfy the check the field
  # exists for.
  miner_bad=0; miner_unknown=0
  case "$mnr" in
    current)          : ;;
    stale|absent)     miner_bad=1 ;;
    untracked)        : ;;
    *)                miner_unknown=1 ;;
  esac

  if [ -z "$exp" ] || [ -z "$got" ]; then
    log "POST-CONDITION UNVERIFIED: could not read counts from $report"
    unverified="$unverified post-condition(unreadable)"
  elif [ "$got" != "$exp" ] || [ "${nen:-0}" != "0" ] || [ "$miner_bad" = "1" ]; then
    log "POST-CONDITION FAILED: the box is not at spec after this run."
    log "  present $got of $exp, not-enabled ${nen:-?}, miner binary $mnr"
    [ "$miner_bad" = "1" ] && \
      log "  The miner binary is $mnr, which is the condition this command exists to prevent."
    log "  Nothing above necessarily errored, which is why this check reads the report"
    log "  rather than trusting the steps."
    failed="$failed post-condition"
  elif [ "$miner_unknown" = "1" ]; then
    log "POST-CONDITION UNVERIFIED: $got of $exp present and everything declared is enabled,"
    log "  but the miner binary state is $mnr, so this run cannot say the box is at spec."
    unverified="$unverified post-condition(miner-$mnr)"
  else
    log "verified: $got of $exp present, everything declared is enabled, miner binary $mnr"
  fi
fi

# Known-bad outranks cannot-verify: if we know something is wrong, that is the more
# actionable of the two facts and it decides the exit code.
if [ -n "$failed" ]; then
  [ -n "$unverified" ] && log "also could not verify:$unverified"
  die "brought partially to spec, these need attention:$failed"
fi
if [ -n "$unverified" ]; then
  log "ERROR: could not verify the box is at spec:$unverified"
  log "  Nothing here says the box is broken. It says this run is not able to tell you, and"
  log "  reporting spec on that basis is the thing this programme removes."
  exit 2
fi
log "done: $steps_run step(s), box is at spec"
