#!/usr/bin/env bash
# Publish what this box actually has installed, so an EXTERNAL check can fail on it.
#
# WHY. Every gate we had verified the repo. CI proves main is good; none of it says a
# byte reached production. On 2026-07-31 nine of fourteen ops scripts had never been
# installed, including audit-drift.sh, whose job is catching exactly that. The
# detector was one of the things that never installed, so nothing noticed for weeks.
#
# This writes counts into the faucet's /app/data volume. The app turns them into a
# verdict and live-smoke asserts that verdict from outside every 15 minutes, which is
# the only channel that has ever reached us unprompted: it caught both outages this
# week while every on-box signal read healthy.
#
# COUNTS, NOT NAMES. The app serves this publicly. Which files are missing from a
# production box is reconnaissance, so no filenames leave here.
#
# FAILS TO "cannot say", NEVER TO "fine". Anything it cannot determine writes
# readable:false, and the app treats that as a gate failure rather than a pass.
set -uo pipefail

REPO_DIR="${BOX_REPORT_REPO:-/opt/zcash-faucet}"
SRC="$REPO_DIR/deploy/z3"
INSTALL_DIR="${BOX_REPORT_INSTALL_DIR:-/opt/faucet}"
UNIT_DIR="${BOX_REPORT_UNIT_DIR:-/etc/systemd/system}"
OUT="${BOX_REPORT_OUT:-/var/lib/docker/volumes/zcash-faucet_faucet_data/_data/box-integrity.json}"
SYSTEMCTL="${BOX_REPORT_SYSTEMCTL:-systemctl}"

write() {
  tmp="$(mktemp "${OUT}.XXXXXX")" || return 1
  printf '%s\n' "$1" > "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" "$OUT"   # atomic
}
cannot_say() { write '{"readable":false}'; exit 0; }

[ -d "$SRC" ] || cannot_say
mkdir -p "$(dirname "$OUT")" 2>/dev/null || cannot_say

expected=0; present=0; not_enabled=0

# Scripts: installed AND byte-identical. A stale copy is not "present": a box running
# code nobody reviewed is the failure, not the absence of code.
for src in "$SRC"/*.sh; do
  [ -e "$src" ] || continue
  expected=$((expected + 1))
  dst="$INSTALL_DIR/$(basename "$src")"
  [ -f "$dst" ] && cmp -s "$src" "$dst" && present=$((present + 1))
done

# Units: installed, identical, AND enabled. Installed-but-disabled works until the
# next reboot and then silently does not, which is worse than never installed.
for src in "$SRC"/*.service "$SRC"/*.timer; do
  [ -e "$src" ] || continue
  expected=$((expected + 1))
  unit="$(basename "$src")"
  dst="$UNIT_DIR/$unit"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    present=$((present + 1))
    # A .service pulled in by its own .timer is not independently enabled, and
    # counting it as disabled would make a correct box permanently red. Only ask
    # about units that carry an [Install] section.
    if grep -q '^\[Install\]' "$src" 2>/dev/null; then
      "$SYSTEMCTL" is-enabled --quiet "$unit" 2>/dev/null || not_enabled=$((not_enabled + 1))
    fi
  fi
done

# Zero expected means the glob found nothing, which is a broken run rather than a
# perfect box. Reporting 0/0 as complete would be the exact false pass this exists
# to prevent.
[ "$expected" -gt 0 ] || cannot_say

write "{\"expected\":${expected},\"present\":${present},\"notEnabled\":${not_enabled},\"at\":$(( $(date +%s) * 1000 )),\"readable\":true}"
