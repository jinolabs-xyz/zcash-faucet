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
# ENABLEMENT IS NOT OURS TO DECIDE. Unit files are installed and systemd is
# reloaded, but nothing is enabled or started. zcash-testnet-miner.service
# enabled means the box starts mining, which is a money-path decision an
# installer must not make on somebody's behalf, and faucet-alert@.service is a
# template that is not enabled at all. Enablement stays where the operator left
# it; this only makes sure the file systemd reads matches the file we reviewed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${OPS_INSTALL_DIR:-/opt/faucet}"
UNIT_DIR="${OPS_UNIT_DIR:-/etc/systemd/system}"
SYSTEMCTL="${OPS_SYSTEMCTL:-systemctl}"
DRY=0
[ "${1:-}" = "--dry-run" ] && { DRY=1; shift; }

log() { echo "$(date -u +%FT%TZ) install-ops: $*"; }

# Explicit argument, then env, then the script's own directory. The fallback stays so
# running it from a checkout still works, but it is now GUARDED below rather than
# trusted, which is the whole point.
SRC="${1:-${OPS_SOURCE_DIR:-$HERE}}"
SRC="$(cd "$SRC" 2>/dev/null && pwd -P)" || { log "ERROR: source directory ${1:-${OPS_SOURCE_DIR:-$HERE}} does not exist"; exit 2; }
DEST_R="$(cd "$INSTALL_DIR" 2>/dev/null && pwd -P || printf '%s' "$INSTALL_DIR")"

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
  place "$src" "$INSTALL_DIR/$(basename "$src")" 755 || rc=1
done

units=0
for src in "$SRC"/*.service "$SRC"/*.timer; do
  [ -e "$src" ] || continue
  before="$changed"
  place "$src" "$UNIT_DIR/$(basename "$src")" 644 || rc=1
  [ "$changed" != "$before" ] && units=$((units + 1))
done

# Only reload when a unit actually changed. A reload is cheap but not free, and a
# log line saying we reloaded when nothing changed is the kind of noise that
# teaches people to stop reading the log.
if [ "$units" -gt 0 ] && [ "$DRY" != "1" ]; then
  "$SYSTEMCTL" daemon-reload || log "WARNING: daemon-reload failed, systemd may still be running the old unit text"
  log "reloaded systemd for $units changed unit(s)"
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
  for src in "$SRC"/*.service "$SRC"/*.timer; do
    [ -e "$src" ] || continue
    name="$(basename "$src")"
    dest="$UNIT_DIR/$name"
    if [ ! -f "$dest" ]; then missing="$missing $name"
    elif ! cmp -s "$src" "$dest"; then differs="$differs $name"
    fi
  done
  if [ -n "$missing" ] || [ -n "$differs" ]; then
    log "POST-CONDITION FAILED: the box does not match the repo after this run."
    [ -n "$missing" ] && log "  never arrived:$missing"
    [ -n "$differs" ] && log "  present but different:$differs"
    log "Not reporting success for a box that is not at spec. Nothing above errored,"
    log "which is exactly why this check exists."
    exit 1
  fi
  log "verified: every ops script and unit at the destination matches the repo"
fi

log "done: $changed installed, $skipped already current"
# Nothing was enabled or started. Say so every run rather than in a comment
# nobody opens, because "installed" reads as "running" to a tired operator.
[ "$changed" -gt 0 ] && log "note: nothing was enabled or started, enablement is unchanged"
exit "$rc"
