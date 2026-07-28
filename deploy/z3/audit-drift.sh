#!/usr/bin/env bash
# Reports where this box and the repo disagree. Read-only, no --apply: see the
# Config drift section of OPERATIONS.md for why, and for the exit codes.
set -uo pipefail

REPO_DIR="${AUDIT_REPO_DIR:-/opt/zcash-faucet}"
OVERLAY_DIR="${AUDIT_OVERLAY_DIR:-$REPO_DIR/deploy/z3}"
UNIT_DIR="${AUDIT_UNIT_DIR:-/etc/systemd/system}"
INSTALL_DIR="${AUDIT_INSTALL_DIR:-/opt/faucet}"
ENV_DIR="${AUDIT_ENV_DIR:-/etc/faucet}"
# Injectable so tests can simulate a host without systemd hermetically,
# rather than by manipulating PATH on a runner that has it.
SYSTEMCTL="${AUDIT_SYSTEMCTL:-systemctl}"
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

drift=0
# A skipped check must never read as a passed one, so these force exit 2.
unverified=""
note_unverified() { unverified="${unverified}${unverified:+
}  - $1"; }
say()   { echo "$*"; }
ok()    { [ "$VERBOSE" = "1" ] && echo "  ok       $*"; return 0; }
# $2 is the fix command, optional where the fix is a judgement call.
found() {
  drift=1
  echo "  DRIFT    $1"
  [ -n "${2:-}" ] && echo "           fix: $2"
  return 0
}
note()  { echo "  note     $*"; }

[ -d "$OVERLAY_DIR" ] || { echo "cannot audit: no overlay dir at $OVERLAY_DIR (set AUDIT_REPO_DIR)"; exit 2; }
have_systemctl=1
if ! command -v "$SYSTEMCTL" >/dev/null 2>&1; then
  have_systemctl=0
  note_unverified "whether any unit is ENABLED: no systemctl on this host, so reboot-survival was not checked"
fi

say "auditing $(hostname 2>/dev/null || echo this box) against $REPO_DIR"
say ""

# Installed, matching, and enabled. A disabled unit is drift: it dies at reboot.
say "systemd units the repo ships"
for src in "$OVERLAY_DIR"/*.service "$OVERLAY_DIR"/*.timer; do
  [ -e "$src" ] || continue
  unit="$(basename "$src")"
  installed="$UNIT_DIR/$unit"
  if [ ! -f "$installed" ]; then
    found "$unit is not installed in $UNIT_DIR" \
      "cp $OVERLAY_DIR/$unit $UNIT_DIR/ && systemctl daemon-reload && systemctl enable --now $unit"
    continue
  fi
  if cmp -s "$src" "$installed"; then
    ok "$unit installed and matches the repo"
  else
    found "$unit differs from the repo copy" \
      "diff $src $installed   # then either cp the repo copy over it, or commit the box's version"
  fi
  if [ "$have_systemctl" = "1" ]; then
    if "$SYSTEMCTL" is-enabled --quiet "$unit" 2>/dev/null; then
      ok "$unit is enabled"
    else
      found "$unit is installed but NOT enabled, so it will not survive a reboot" \
        "systemctl enable --now $unit"
    fi
  fi
done
say ""

# Union of two signals, because each misses what the other catches: the repo's
# own unit names (so a rename cannot fall outside a prefix list) and our
# conventions (so a hand-installed unit the repo never had is still seen).
ours_re="$(for f in "$OVERLAY_DIR"/*.service "$OVERLAY_DIR"/*.timer; do
             [ -e "$f" ] && basename "$f"; done | paste -sd'|' -)"
in_repo()  { [ -n "$ours_re" ] && printf '%s' "$1" | grep -qxE "$ours_re"; }
is_ours() {
  in_repo "$1" && return 0
  local stem="${1%.*}"
  in_repo "$stem.service" || in_repo "$stem.timer" && return 0
  case "$1" in faucet-*|zsnap-*|zcash-*) return 0 ;; esac
  return 1
}

say "state on the box that the repo does not describe"
for installed in "$UNIT_DIR"/*.service "$UNIT_DIR"/*.timer; do
  [ -e "$installed" ] || continue
  unit="$(basename "$installed")"
  # A unit the repo ships is checked above. Anything else is only ours if it
  # shares a stem with something we ship, e.g. a hand-added faucet-x.timer
  # beside our faucet-x.service.
  in_repo "$unit" && continue          # already checked above
  is_ours "$unit" || continue
  [ -f "$OVERLAY_DIR/$unit" ] \
    || found "$unit is installed but the repo has no copy of it, so a rebuild loses it" \
         "cp $installed $OVERLAY_DIR/ && git -C $REPO_DIR add deploy/z3/$unit   # then commit it"
done
for dropin_dir in "$UNIT_DIR"/*.d; do
  [ -d "$dropin_dir" ] || continue
  unit="$(basename "$dropin_dir" .d)"
  # Drop-ins matter only for units we ship; the box has others of its own.
  is_ours "$unit" || continue
  for conf in "$dropin_dir"/*.conf; do
    [ -e "$conf" ] || continue
    found "drop-in $unit.d/$(basename "$conf") exists on the box and is not in the repo" \
      "fold its directives into $OVERLAY_DIR/$unit (or add the drop-in to the repo), then commit"
    # Allowlist: only KEY= lines print, so nothing can slip through a rule
    # that does not exist. Continuation lines and comments carry secrets too.
    if [ "$VERBOSE" = "1" ]; then
      sed -nE 's/^[[:space:]]*(Environment=[A-Za-z_][A-Za-z0-9_]*=).*/             | \1<redacted>/p
               t
               s/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=).*/             | \1<redacted>/p' "$conf"
    fi
  done
done
say ""

# --- compose overrides --------------------------------------------------------
say "compose overrides"
for f in "$OVERLAY_DIR"/docker-compose.override.y*ml "$OVERLAY_DIR"/*.override.y*ml; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  if git -C "$REPO_DIR" ls-files --error-unmatch "deploy/z3/$name" >/dev/null 2>&1; then
    ok "$name is tracked in git"
  else
    found "$name is untracked, so a rebuild will not have it" \
      "git -C $REPO_DIR add deploy/z3/$name   # then commit it"
  fi
done
say ""

# A stale copy in $INSTALL_DIR means the box runs code nobody reviewed.
say "scripts in $INSTALL_DIR"
for src in "$OVERLAY_DIR"/*.sh; do
  [ -e "$src" ] || continue
  script="$(basename "$src")"
  installed="$INSTALL_DIR/$script"
  referenced=0
  grep -qs "$INSTALL_DIR/$script" "$OVERLAY_DIR"/*.service && referenced=1

  if [ ! -f "$installed" ]; then
    # Not installed is only drift when a unit expects to run it. An overlay
    # script nobody deployed is just not deployed.
    [ "$referenced" = "1" ] && found "$script is referenced by a unit but missing from $INSTALL_DIR" \
      "cp $src $INSTALL_DIR/ && chmod +x $installed"
    continue
  fi

  # It IS installed, so it has to match whether or not a .service names it.
  # Keying this off unit references meant the scripts a unit calls INDIRECTLY
  # were never compared: drift-report.sh runs audit-access.sh and
  # audit-drift.sh, so stale copies of the auditors themselves were invisible
  # to the auditor. The tool that reports staleness has to check itself.
  if cmp -s "$src" "$installed"; then
    ok "$script matches the repo"
  else
    found "$script in $INSTALL_DIR differs from the repo (the box is running unreviewed code)" \
      "diff $src $installed   # then cp the repo copy over it, or get the box's version reviewed"
  fi
done
say ""

# These hold secrets, so presence only. Values are never read.
say "env files (presence only, values are never read)"
for f in "$ENV_DIR/watchdog.env" "$ENV_DIR/zsnap.env" "$ENV_DIR/backup.env" \
         "$ENV_DIR/metrics.env" "$ENV_DIR/miner.env" /etc/faucet-domain; do
  if [ -f "$f" ]; then
    ok "$f present"
  else
    note "$f absent (fine if the feature it configures is unused)"
  fi
done
say ""

if [ -n "$unverified" ]; then
  say "NOT VERIFIED"
  say "$unverified"
  say ""
fi

if [ "$drift" = "0" ]; then
  if [ -n "$unverified" ]; then
    # Clean is a claim about everything, and something was skipped.
    say "no drift found in what could be checked, but the audit was INCOMPLETE (see NOT VERIFIED)"
    exit 2
  fi
  say "no drift: this box matches the repo"
  exit 0
fi
say "DRIFT FOUND. The fix is to put these into the repo, not to change the box:"
say "  - a hand-installed unit or drop-in belongs in deploy/z3/ and in the install docs"
say "  - an untracked override belongs in git"
say "  - a stale script in $INSTALL_DIR means re-copying it, or the box is ahead of review"
say "Nothing was changed by this audit."
exit 1
