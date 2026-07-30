#!/usr/bin/env bash
# Puts the repo's ops scripts and units on the box. This is the actor
# audit-drift.sh has been describing since it was written: that audit compares
# every deploy/z3/*.sh against /opt/faucet/<name> and reports drift per file, and
# until now nothing performed the copy. Every merged ops fix sat in the checkout,
# unrun, which is why the watchdog served pre-#175 code for a day (#181).
#
# Usage:  install-ops.sh [--dry-run]
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
[ "${1:-}" = "--dry-run" ] && DRY=1

log() { echo "$(date -u +%FT%TZ) install-ops: $*"; }

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
for src in "$HERE"/*.sh; do
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
for src in "$HERE"/*.service "$HERE"/*.timer; do
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

log "done: $changed installed, $skipped already current"
# Nothing was enabled or started. Say so every run rather than in a comment
# nobody opens, because "installed" reads as "running" to a tired operator.
[ "$changed" -gt 0 ] && log "note: nothing was enabled or started, enablement is unchanged"
exit "$rc"
