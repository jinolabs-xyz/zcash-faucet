#!/usr/bin/env bash
# Reports the difference between what is ON this box and what the repo SAYS
# should be there. Read-only, always.
#
# The problem this exists for: our story is that a rebuilt box comes back from
# cloud-init plus deploy.sh. In practice a box accumulates hand-installed
# state (a drop-in setting MINER_MODE=submit, a compose override with the
# miner address, unit files copied by hand) that the repo does not describe.
# A rebuild silently loses it, and nothing breaks loudly: the box comes up,
# serves, and is quietly missing work only the person who typed it knows
# about. That is the failure this catches.
#
#   audit-drift.sh              report drift
#   audit-drift.sh --verbose    also list what matched, not just what drifted
#
# Exit codes, stable so a timer or a CI job can use them:
#   0  no drift, the box matches the repo
#   1  drift found, details on stdout
#   2  could not audit, or could not audit EVERYTHING, so the result is
#      unknown rather than clean. An audit that cannot run must never look
#      like a pass, and neither must one that skipped a check. Anything it
#      could not verify is listed under NOT VERIFIED and forces this code.
#
# It does NOT have an --apply flag on purpose. Reconciling a box to the repo
# would delete exactly the hand work this is meant to protect. The fix for
# drift is putting the change in the repo, and a tool that quietly did the
# opposite would make the problem invisible again.
#
# Secret values are never printed. For env files it reports presence and
# nothing else, because a drift report is something you paste into an issue.
set -uo pipefail

REPO_DIR="${AUDIT_REPO_DIR:-/opt/zcash-faucet}"
OVERLAY_DIR="${AUDIT_OVERLAY_DIR:-$REPO_DIR/deploy/z3}"
UNIT_DIR="${AUDIT_UNIT_DIR:-/etc/systemd/system}"
INSTALL_DIR="${AUDIT_INSTALL_DIR:-/opt/faucet}"
ENV_DIR="${AUDIT_ENV_DIR:-/etc/faucet}"
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

drift=0
# Checks that could not be performed. A tool whose job is verification must
# never let a skipped check read as a passed one, so these are collected and
# reported explicitly, and they change the exit code.
unverified=""
note_unverified() { unverified="${unverified}${unverified:+
}  - $1"; }
say()   { echo "$*"; }
ok()    { [ "$VERBOSE" = "1" ] && echo "  ok       $*"; return 0; }
# Every finding carries the command that fixes it, so acting on a report is a
# paste rather than a puzzle. $2 is optional for findings whose fix is a
# judgement call rather than a command.
found() {
  drift=1
  echo "  DRIFT    $1"
  [ -n "${2:-}" ] && echo "           fix: $2"
  return 0
}
note()  { echo "  note     $*"; }

[ -d "$OVERLAY_DIR" ] || { echo "cannot audit: no overlay dir at $OVERLAY_DIR (set AUDIT_REPO_DIR)"; exit 2; }
have_systemctl=1
if ! command -v systemctl >/dev/null 2>&1; then
  have_systemctl=0
  note_unverified "whether any unit is ENABLED: no systemctl on this host, so reboot-survival was not checked"
fi

say "auditing $(hostname 2>/dev/null || echo this box) against $REPO_DIR"
say ""

# --- units the repo ships -----------------------------------------------------
# For each unit in the repo: is it installed, does its content match, is it
# enabled. A unit present but disabled is drift too: it will not come back
# after a reboot, which is the whole point of installing it.
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
    if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
      ok "$unit is enabled"
    else
      found "$unit is installed but NOT enabled, so it will not survive a reboot" \
        "systemctl enable --now $unit"
    fi
  fi
done
say ""

# --- units and drop-ins on the box that the repo does not describe ------------
# This is the half that matters most: state nobody wrote down. A drop-in is
# how tonight's MINER_MODE=submit got set, and it is invisible in the repo.
say "state on the box that the repo does not describe"
for installed in "$UNIT_DIR"/*.service "$UNIT_DIR"/*.timer; do
  [ -e "$installed" ] || continue
  unit="$(basename "$installed")"
  # Only judge units that look like ours; the box runs plenty that are not.
  case "$unit" in
    faucet-*|zsnap-*|zcash-*) ;;
    *) continue ;;
  esac
  [ -f "$OVERLAY_DIR/$unit" ] \
    || found "$unit is installed but the repo has no copy of it, so a rebuild loses it" \
         "cp $installed $OVERLAY_DIR/ && git -C $REPO_DIR add deploy/z3/$unit   # then commit it"
done
for dropin_dir in "$UNIT_DIR"/*.d; do
  [ -d "$dropin_dir" ] || continue
  unit="$(basename "$dropin_dir" .d)"
  case "$unit" in
    faucet-*|zsnap-*|zcash-*) ;;
    *) continue ;;
  esac
  for conf in "$dropin_dir"/*.conf; do
    [ -e "$conf" ] || continue
    found "drop-in $unit.d/$(basename "$conf") exists on the box and is not in the repo" \
      "fold its directives into $OVERLAY_DIR/$unit (or add the drop-in to the repo), then commit"
    # The values matter to whoever reads the report, and a drop-in is
    # configuration rather than a secret. Show the directives, not a diff.
    if [ "$VERBOSE" = "1" ]; then
      sed 's/^/             | /' "$conf"
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

# --- scripts installed for the units to run -----------------------------------
# The units reference /opt/faucet/*.sh. If those are stale copies of the repo
# scripts, the box is running code nobody is reviewing.
say "scripts in $INSTALL_DIR"
for src in "$OVERLAY_DIR"/*.sh; do
  [ -e "$src" ] || continue
  script="$(basename "$src")"
  # Only the ones a unit actually runs from INSTALL_DIR.
  grep -qs "$INSTALL_DIR/$script" "$OVERLAY_DIR"/*.service || continue
  installed="$INSTALL_DIR/$script"
  if [ ! -f "$installed" ]; then
    found "$script is referenced by a unit but missing from $INSTALL_DIR" \
      "cp $src $INSTALL_DIR/ && chmod +x $installed"
  elif cmp -s "$src" "$installed"; then
    ok "$script matches the repo"
  else
    found "$script in $INSTALL_DIR differs from the repo (the box is running unreviewed code)" \
      "diff $src $installed   # then cp the repo copy over it, or get the box's version reviewed"
  fi
done
say ""

# --- env files: presence only, never contents ---------------------------------
# These hold secrets (webhook URLs, backup passphrase, RPC passwords), so the
# audit reports whether they exist and stops there. A missing one is drift
# because the unit that needs it will start and quietly do nothing useful.
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
    # Not "clean": clean is a claim about everything, and something was
    # skipped. Exit 2 so a scheduled check cannot read this as a pass.
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
