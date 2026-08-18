#!/usr/bin/env bash
# Puts the repo's ops scripts and units on the box. This is the actor
# audit-drift.sh has been describing since it was written: that audit compares
# every deploy/z3/*.sh against /opt/faucet/<name> and reports drift per file, and
# until now nothing performed the copy. Every merged ops fix sat in the checkout,
# unrun, which is why the watchdog served pre-#175 code for a day (#181).
#
# Usage:  install-ops.sh [--dry-run] [source-dir]
#         OPS_SOURCE_DIR=<repo>/deploy/z3 install-ops.sh
#
# THE SOURCE IS EXPLICIT NOW, AND THAT IS A BUG FIX, NOT TIDINESS. This used to take
# its source from its OWN location, and auto-deploy.sh installs this script to
# /opt/faucet and then runs the INSTALLED copy. So on the box the source directory
# WAS the destination: it globbed /opt/faucet/*.sh and installed each file onto
# itself, reporting "0 installed, N already current" and exiting 0. Anything present
# in the repo and absent from /opt/faucet was never seen at all, because the glob
# could not see it. 19 of 25 required files sat uninstalled for weeks, including
# audit-drift.sh, the very auditor that would have reported them missing.
#
# Nothing caught it because no suite invoked this script, and running it from the
# checkout by hand is the one situation where source and destination differ, so it
# worked every time anyone tried it.
#
# Idempotent: it compares before copying, so a no-change run touches nothing and
# does not reload systemd.
#
# ENABLEMENT IS NOT OURS TO DECIDE, SO THE REPO DECIDES IT. deploy/z3/enabled-units
# lists the units that must be enabled, with the reason for each, and this installs
# and enables exactly those. The distinction matters: the installer is not choosing
# to arm anything, it is enforcing a decision that went through review.
#
# Leaving enablement to a human is what we did before, and it silently was not done.
# Installed-but-not-enabled works until the next reboot and then quietly does not,
# and the reporting timer that would have said so was one of the units nobody enabled.
#
# NOTHING IS EVER DISABLED here. A unit absent from that file is left exactly as the
# operator has it, because turning something OFF on a running box is not a decision a
# file sync should make either. zcash-testnet-miner.service is deliberately not listed:
# mining is a money path and it gets armed on the box, not by a file sync.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${OPS_INSTALL_DIR:-/opt/faucet}"
UNIT_DIR="${OPS_UNIT_DIR:-/etc/systemd/system}"
SYSTEMCTL="${OPS_SYSTEMCTL:-systemctl}"
# Declared with the other configuration rather than beside its first use: the post-condition
# below also reads it, and under `set -u` a later definition is a fatal unbound variable.
# That is exactly how my first version of this failed, with the enable step never reached.
ENABLED_UNITS_FILE_RAW="${OPS_ENABLED_UNITS:-}"
DRY=0
[ "${1:-}" = "--dry-run" ] && { DRY=1; shift; }

log() { echo "$(date -u +%FT%TZ) install-ops: $*"; }

# Explicit argument, then env, then the script's own directory. The fallback stays so
# running it from a checkout still works, but it is now GUARDED below rather than
# trusted, which is the whole point.
SRC="${1:-${OPS_SOURCE_DIR:-$HERE}}"
SRC="$(cd "$SRC" 2>/dev/null && pwd -P)" || { log "ERROR: source directory ${1:-${OPS_SOURCE_DIR:-$HERE}} does not exist"; exit 2; }
DEST_R="$(cd "$INSTALL_DIR" 2>/dev/null && pwd -P || printf '%s' "$INSTALL_DIR")"
ENABLED_UNITS_FILE="${ENABLED_UNITS_FILE_RAW:-$SRC/enabled-units}"

# THE REFUSAL. Source == destination means every copy is a file onto itself and every
# absent file is invisible, so a run in that state cannot install anything and must
# not be allowed to report that it did.
if [ "$SRC" = "$DEST_R" ]; then
  log "REFUSING TO RUN: the source directory and the install directory are the same path:"
  log "  $SRC"
  log "Every copy would be a file onto itself, and any file missing from the destination"
  log "would be invisible to the glob, so this would install NOTHING and exit 0. That is"
  log "how 19 of 25 required files sat uninstalled for weeks, audit-drift.sh among them."
  log "Pass the repo's deploy/z3 explicitly:  install-ops.sh /opt/zcash-faucet/deploy/z3"
  exit 2
fi

# A source directory with no scripts in it is not an empty job, it is a wrong path.
# Without this the loops below iterate zero times and the run reports success.
src_count=0
for f in "$SRC"/*.sh; do [ -e "$f" ] && src_count=$((src_count + 1)); done
if [ "$src_count" -eq 0 ]; then
  log "REFUSING TO RUN: no *.sh found in $SRC, so this is not the ops source directory."
  log "Installing nothing and reporting success is the failure this refusal exists for."
  exit 2
fi

changed=0
skipped=0

# $1 src, $2 dest, $3 mode
place() {
  local src="$1" dest="$2" mode="$3"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    skipped=$((skipped + 1))
    return 0
  fi
  if [ "$DRY" = "1" ]; then
    log "would install $(basename "$src") -> $dest"
    changed=$((changed + 1))
    return 0
  fi
  install -m "$mode" "$src" "$dest" || { log "ERROR: could not install $dest"; return 1; }
  log "installed $(basename "$src") -> $dest"
  changed=$((changed + 1))
}

[ "$DRY" = "1" ] || mkdir -p "$INSTALL_DIR" || { log "ERROR: cannot create $INSTALL_DIR"; exit 1; }

# EVERY *.sh, not only the ones a unit names. Scripts reach their siblings by
# $(dirname "$0"): drift-report.sh runs audit-drift.sh and audit-access.sh, and
# watchdog.sh, faucet-metrics.sh and drift-report.sh all send through alert.sh.
# Installing only unit-referenced scripts would leave those calls pointing at
# files that are not there, and the failure would be a silent alert rather than a
# missing unit.
rc=0
# Tracked because a long-running service does NOT pick up a new script on its own (see
# the restart block after enablement). Only watchdog.sh needs it today; the timer-driven
# scripts re-exec their installed copy each run and so update themselves.
watchdog_changed=0
for src in "$SRC"/*.sh; do
  [ -e "$src" ] || continue
  case "$(basename "$src")" in
    # Both are skipped for the same reason and it is not tidiness. auto-deploy.sh
    # is what CALLS this script, so copying over it here would overwrite a file
    # the running shell is still reading, and bash reads lazily: the interpreter
    # can resume at a byte offset that now falls mid-line in different text. Each
    # of those two installs itself, at a moment when it is not the running
    # script. Found by driving this against a fake box, not by reading it.
    install-ops.sh|auto-deploy.sh) continue ;;
  esac
  before="$changed"
  place "$src" "$INSTALL_DIR/$(basename "$src")" 755 || rc=1
  [ "$(basename "$src")" = "watchdog.sh" ] && [ "$changed" != "$before" ] && watchdog_changed=1
done

units=0
for src in "$SRC"/*.service "$SRC"/*.timer "$SRC"/*.socket; do
  [ -e "$src" ] || continue
  before="$changed"
  place "$src" "$UNIT_DIR/$(basename "$src")" 644 || rc=1
  [ "$changed" != "$before" ] && units=$((units + 1))
done

# DROP-INS, because this script globbed the top level only and a file in a subdirectory
# was therefore reviewed, merged, and never installed. That is worse than not having it:
# it is in the repo, so it reads as shipped. Found the day ctaz-node.service.d landed,
# which would have cost a rebuilt box its sync tuning with nothing anywhere saying so.
for dir in "$SRC"/*.service.d; do
  [ -d "$dir" ] || continue
  destdir="$UNIT_DIR/$(basename "$dir")"
  [ "$DRY" = "1" ] || mkdir -p "$destdir" || { log "ERROR: cannot create $destdir"; rc=1; continue; }
  for src in "$dir"/*.conf; do
    [ -e "$src" ] || continue
    before="$changed"
    place "$src" "$destdir/$(basename "$src")" 644 || rc=1
    [ "$changed" != "$before" ] && units=$((units + 1))
  done
done

# Build assets: not scripts, not units, but the box needs them. DECLARED here rather
# than globbed, because "install every subdirectory" would sweep in miner/target, which
# is hundreds of megabytes of build output.
ASSET_DIRS="ctaz-build"
for name in $ASSET_DIRS; do
  [ -d "$SRC/$name" ] || continue
  destdir="$INSTALL_DIR/$name"
  [ "$DRY" = "1" ] || mkdir -p "$destdir" || { log "ERROR: cannot create $destdir"; rc=1; continue; }
  for src in "$SRC/$name"/*; do
    [ -f "$src" ] || continue
    place "$src" "$destdir/$(basename "$src")" 644 || rc=1
  done
done

# ANYTHING ELSE WITH FILES IN IT GETS NAMED. The bug above was not that a rule was
# missing, it was that its absence was silent, so a subdirectory nobody wired up looks
# exactly like one that needs nothing. Excluded: tests (never runs on the box) and
# miner (source and build output; the miner ships as a built binary, not as a tree).
for dir in "$SRC"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  case "$name" in tests|miner|*.service.d) continue ;; esac
  case " $ASSET_DIRS " in *" $name "*) continue ;; esac
  find "$dir" -type f -print -quit 2>/dev/null | grep -q . && \
    log "NOTE: $name/ holds files and no rule installs it. Add it to ASSET_DIRS or say why not."
done

# Only reload when a unit actually changed. A reload is cheap but not free, and a
# log line saying we reloaded when nothing changed is the kind of noise that
# teaches people to stop reading the log.
if [ "$units" -gt 0 ] && [ "$DRY" != "1" ]; then
  "$SYSTEMCTL" daemon-reload || log "WARNING: daemon-reload failed, systemd may still be running the old unit text"
  log "reloaded systemd for $units changed unit(s)"
fi

# --- enablement, from the repo's declaration ------------------------------------
enabled_now=0
enable_failed=""
if [ "$DRY" != "1" ] && [ -f "$ENABLED_UNITS_FILE" ]; then
  while IFS= read -r line; do
    unit="${line%%#*}"
    unit="$(printf '%s' "$unit" | tr -d '[:space:]')"
    [ -n "$unit" ] || continue
    # Only enable what we actually installed. Enabling a unit whose file is not there
    # would be systemd's error to report, and we would rather say it ourselves.
    if [ ! -f "$UNIT_DIR/$unit" ]; then
      enable_failed="$enable_failed $unit(not-installed)"
      continue
    fi
    if "$SYSTEMCTL" is-enabled --quiet "$unit" 2>/dev/null; then
      continue
    fi
    if "$SYSTEMCTL" enable --now "$unit" >/dev/null 2>&1; then
      log "enabled $unit"
      enabled_now=$((enabled_now + 1))
    else
      enable_failed="$enable_failed $unit"
    fi
  done < "$ENABLED_UNITS_FILE"
  if [ -n "$enable_failed" ]; then
    log "ERROR: could not enable:$enable_failed"
    rc=1
  fi
fi

# --- restart the watchdog when its script changed ------------------------------
# INSTALLING A SCRIPT IS NOT THE SAME AS APPLYING IT. faucet-watchdog is a bash
# `while true` loop that read watchdog.sh once at start and never re-reads the file, so a
# new watchdog.sh sits on disk, matching the repo and passing audit-drift, while the
# running process keeps executing the old code. 2026-08-18: the step-5 poison auto-heal
# was on the box for hours in exactly that state, and a crash loop that should have
# self-healed ran to 944 restarts instead.
#
# Restart it, but ONLY when its script actually changed and it is already active. Starting
# a stopped unit is an arming decision that belongs to enabled-units, not to a file sync -
# the same line this script draws everywhere else.
if [ "$watchdog_changed" = "1" ] && [ "$DRY" != "1" ]; then
  if "$SYSTEMCTL" is-active --quiet faucet-watchdog.service 2>/dev/null; then
    if "$SYSTEMCTL" restart faucet-watchdog.service >/dev/null 2>&1; then
      log "watchdog.sh changed; restarted faucet-watchdog.service so the new code actually runs"
    else
      log "ERROR: watchdog.sh changed but restarting faucet-watchdog.service failed; it is still running the OLD code"
      rc=1
    fi
  else
    log "watchdog.sh changed but faucet-watchdog.service is not active; leaving it as the operator has it"
  fi
fi

# POST-CONDITIONS. "The loop finished" is not "the files are there", and this script
# reported the first while meaning the second for weeks. So verify the end state from
# the destination side, which is the only side that matters.
if [ "$DRY" != "1" ]; then
  missing=""
  differs=""
  for src in "$SRC"/*.sh; do
    [ -e "$src" ] || continue
    name="$(basename "$src")"
    case "$name" in install-ops.sh|auto-deploy.sh) continue ;; esac
    dest="$INSTALL_DIR/$name"
    if [ ! -f "$dest" ]; then missing="$missing $name"
    elif ! cmp -s "$src" "$dest"; then differs="$differs $name"
    fi
  done
  for src in "$SRC"/*.service "$SRC"/*.timer "$SRC"/*.socket; do
    [ -e "$src" ] || continue
    name="$(basename "$src")"
    dest="$UNIT_DIR/$name"
    if [ ! -f "$dest" ]; then missing="$missing $name"
    elif ! cmp -s "$src" "$dest"; then differs="$differs $name"
    fi
  done
  # The same two checks over the files the top-level globs do not reach. An install rule
  # without a matching post-condition is how a file goes missing quietly, which is the
  # exact shape of the bug these loops were added for.
  for dir in "$SRC"/*.service.d; do
    [ -d "$dir" ] || continue
    for src in "$dir"/*.conf; do
      [ -e "$src" ] || continue
      name="$(basename "$dir")/$(basename "$src")"
      dest="$UNIT_DIR/$name"
      if [ ! -f "$dest" ]; then missing="$missing $name"
      elif ! cmp -s "$src" "$dest"; then differs="$differs $name"
      fi
    done
  done
  for adir in $ASSET_DIRS; do
    [ -d "$SRC/$adir" ] || continue
    for src in "$SRC/$adir"/*; do
      [ -f "$src" ] || continue
      name="$adir/$(basename "$src")"
      dest="$INSTALL_DIR/$name"
      if [ ! -f "$dest" ]; then missing="$missing $name"
      elif ! cmp -s "$src" "$dest"; then differs="$differs $name"
      fi
    done
  done
  not_enabled=""
  if [ -f "$ENABLED_UNITS_FILE" ]; then
    while IFS= read -r line; do
      unit="${line%%#*}"
      unit="$(printf '%s' "$unit" | tr -d '[:space:]')"
      [ -n "$unit" ] || continue
      "$SYSTEMCTL" is-enabled --quiet "$unit" 2>/dev/null || not_enabled="$not_enabled $unit"
    done < "$ENABLED_UNITS_FILE"
  fi
  if [ -n "$missing" ] || [ -n "$differs" ] || [ -n "$not_enabled" ]; then
    log "POST-CONDITION FAILED: the box does not match the repo after this run."
    [ -n "$missing" ] && log "  never arrived:$missing"
    [ -n "$differs" ] && log "  present but different:$differs"
    [ -n "$not_enabled" ] && log "  declared enabled but is NOT:$not_enabled"
    log "Not reporting success for a box that is not at spec. Nothing above errored,"
    log "which is exactly why this check exists."
    exit 1
  fi
  log "verified: every ops script and unit matches the repo, and every declared unit is enabled"
fi

log "done: $changed installed, $skipped already current, $enabled_now newly enabled"
# Nothing was enabled or started. Say so every run rather than in a comment
# nobody opens, because "installed" reads as "running" to a tired operator.
# Only the units the repo declares were touched. Say what was NOT, because "installed"
# reads as "running" to a tired operator and the miner is deliberately not in that list.
log "note: units not listed in $(basename "$ENABLED_UNITS_FILE") were left exactly as they were"
exit "$rc"
