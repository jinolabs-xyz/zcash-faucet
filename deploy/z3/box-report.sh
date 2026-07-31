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
    # A .service activated by its OWN .timer must not be independently enabled:
    # enabling it would additionally run it at boot, which is not what a timer
    # means. So the question is only asked of units nothing else activates.
    #
    # My first version asked it of anything carrying an [Install] section, which
    # flagged four correctly configured units and made a healthy box report as
    # incomplete. faucet-backup.service is the proof: `disabled`, and backups have
    # been running on schedule the whole time. A gate that cries wolf gets muted,
    # so a false alarm here is not the harmless direction.
    ask=1
    case "$unit" in
      *.service) [ -e "${src%.service}.timer" ] && ask=0 ;;
    esac
    if [ "$ask" = "1" ] && grep -q '^\[Install\]' "$src" 2>/dev/null; then
      "$SYSTEMCTL" is-enabled --quiet "$unit" 2>/dev/null || not_enabled=$((not_enabled + 1))
    fi
  fi
done

# THE COMPILED MINER BINARY, which this report could not see at all until now.
#
# It counted *.sh and units, so it answered "28 of 28" while /opt/faucet/zcash-testnet-miner
# was a four-day-old build writing no heartbeat. The number was true about scripts and
# silent about the binary, which is a check that cannot fail about the thing it appears to
# cover: the same shape as FAUCET_MINER_ACTIVE, which also could not be false while the
# miner was broken.
#
# It cannot be content-compared, because the repo ships SOURCE and the box runs a build. So
# the question asked is the one that actually went wrong: is the binary OLDER than the
# sources it was built from. That is staleness by mtime, and mtime is not content: a build
# from edited-then-reverted sources would read current. It catches the real failure mode
# here, which is a merged Rust change that nobody compiled, and it is honest about being a
# freshness check rather than a verification.
MINER_SRC_DIR="${BOX_MINER_SRC_DIR:-$SRC/miner/src}"
MINER_BIN="${BOX_MINER_BIN:-$INSTALL_DIR/zcash-testnet-miner}"
miner_state="untracked"
if [ -d "$MINER_SRC_DIR" ]; then
  expected=$((expected + 1))
  if [ ! -f "$MINER_BIN" ]; then
    miner_state="absent"
  else
    # ASK GIT FIRST, BECAUSE MTIME LIES IN A FRESH CLONE.
    #
    # git sets working-tree mtimes to CHECKOUT time. So in a fresh clone every source is
    # newer than any binary that exists, and an older-than-sources test cannot return
    # anything but `stale`. The CTO hit this dry-running #301 from /tmp: it reported
    # `28 of 29, minerBinary stale` and the clone had decided the answer before the check
    # ran. A CI job that clones fresh would report stale forever and look like a real
    # finding.
    #
    # That is our false-pass doctrine pointed the other way: not a check that passes while
    # verifying nothing, but one that FAILS for a reason unrelated to the thing under test.
    #
    # The commit timestamp of the last change to the miner is stable across clones, so it
    # is the honest question: was the binary built before the last change we made. mtime is
    # the fallback for a non-git tree, and it is weaker for exactly the reason above.
    src_time=0
    src_basis="mtime"
    if command -v git >/dev/null 2>&1 &&
       git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
      src_basis="git"
      src_time="$(git -C "$REPO_DIR" log -1 --format=%ct -- deploy/z3/miner 2>/dev/null || echo 0)"
      [ -n "$src_time" ] || src_time=0
      # Uncommitted changes under miner/ mean we cannot know what the binary was built
      # from. That is UNKNOWN, not stale: accusing a binary on evidence we do not have is
      # the same error as excusing one.
      if [ -n "$(git -C "$REPO_DIR" status --porcelain -- deploy/z3/miner 2>/dev/null)" ]; then
        src_time=0
        src_basis="dirty"
      fi
    fi

    # RECURSIVE, and the manifests count too. A top-level *.rs glob would miss
    # src/anything/mod.rs the day someone adds a module, and a stale binary would then
    # read `current`: the same false pass this check exists to remove, hiding in the
    # check itself. Cargo.toml and Cargo.lock are included because a dependency bump
    # changes the binary without touching a single .rs file.
    newest_src=0
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      m="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
      [ "$m" -gt "$newest_src" ] && newest_src="$m"
    done <<EOF
$(find "$MINER_SRC_DIR" -type f -name '*.rs' 2>/dev/null
  for mf in "$MINER_SRC_DIR/../Cargo.toml" "$MINER_SRC_DIR/../Cargo.lock"; do
    [ -f "$mf" ] && printf '%s\n' "$mf"
  done)
EOF
    bin_m="$(stat -c %Y "$MINER_BIN" 2>/dev/null || echo 0)"
    # git's answer wins when we have one, because it survives a clone.
    case "$src_basis" in
      git)   [ "$src_time" -gt 0 ] && newest_src="$src_time" ;;
      dirty) newest_src=0 ;;
      mtime)
        # WITHOUT GIT WE CANNOT TELL STALE FROM A FRESH CHECKOUT, so we must not claim
        # either. The comparison is only meaningful against a tree whose mtimes were set by
        # the BUILD rather than by git, and nothing here can guarantee that. A binary that
        # is NEWER than every source is still sound: a checkout can only make sources
        # newer, never older. A binary that is older is unknown, not stale.
        #
        # App's framing, and it turns the false-signal story into a behaviour instead of a
        # warning comment. Same not-seen versus known-bad distinction as the rest of this
        # file.
        if [ "$newest_src" -gt 0 ] && [ "$bin_m" -lt "$newest_src" ]; then
          newest_src=0
        fi ;;
    esac
    # Equal counts as current: a build and a checkout can land in the same second.
    if [ "$newest_src" -gt 0 ] && [ "$bin_m" -ge "$newest_src" ]; then
      miner_state="current"
      present=$((present + 1))
    elif [ "$newest_src" -eq 0 ] || [ "$bin_m" -eq 0 ]; then
      # Could not read one of the timestamps, so we learned nothing. Not counted as
      # present, and reported as its own state rather than as staleness we did not observe.
      miner_state="unknown"
    else
      miner_state="stale"
    fi
  fi
fi

# Zero expected means the glob found nothing, which is a broken run rather than a
# perfect box. Reporting 0/0 as complete would be the exact false pass this exists
# to prevent.
[ "$expected" -gt 0 ] || cannot_say

# minerBinary is emitted as its own field as well as counted, so the panel can say WHY
# the count is short instead of only that it is. A number that drops with no reason
# attached sends someone to the box to find out.
write "{\"expected\":${expected},\"present\":${present},\"notEnabled\":${not_enabled},\"minerBinary\":\"${miner_state}\",\"at\":$(( $(date +%s) * 1000 )),\"readable\":true}"
