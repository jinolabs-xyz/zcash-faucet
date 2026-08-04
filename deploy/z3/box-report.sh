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

# Units: installed, identical, AND, where the repo says so, enabled.
#
# WHICH UNITS MUST BE ENABLED IS DECLARED IN enabled-units, NOT INFERRED HERE.
# The old rule inferred it: any unit carrying [Install] with no companion timer
# had to be enabled. That heuristic and the declaration disagreed the first time
# a unit shipped deliberately dark: ctaz-node.service carries [Install], is
# documented in enabled-units as deliberately NOT enabled, and the panel went
# red for ten hours over a unit behaving exactly as reviewed. Two files carried
# the contract and only the installers read the file, so this reporter enforced
# a rule the repo had already replaced.
#
# Now the declaration is the single authority, same as for install-ops and
# bring-to-spec: notEnabled counts units LISTED there that are not enabled.
# A unit absent from the file is the operator's business in both directions,
# EXCEPT that enabled-without-being-declared is counted separately below,
# because that file explicitly promises this reporter surfaces that drift.
declared_units() {
  # Comments and blanks ignored, same parse the installers use.
  sed -e 's/#.*$//' -e 's/[[:space:]]*$//' -e '/^$/d' "$SRC/enabled-units" 2>/dev/null
}

enabled_undeclared=0
for src in "$SRC"/*.service "$SRC"/*.timer; do
  [ -e "$src" ] || continue
  expected=$((expected + 1))
  unit="$(basename "$src")"
  dst="$UNIT_DIR/$unit"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    present=$((present + 1))
    if declared_units | grep -qxF "$unit"; then
      "$SYSTEMCTL" is-enabled --quiet "$unit" 2>/dev/null || not_enabled=$((not_enabled + 1))
    else
      # Not declared: disabled is fine (ctaz-node, the miner pattern), and a
      # TEMPLATE cannot be asked at all. Enabled-but-undeclared is reported as
      # its own count, INFORMATIONAL, never failing the gate: faucet.service and
      # the autodeploy timer are legitimately operator-enabled and undeclared,
      # and a gate that cries wolf on a correct box is one people learn to mute.
      # A count, never names: this reaches a public endpoint.
      case "$unit" in
        *@.service) ;;
        *) "$SYSTEMCTL" is-enabled --quiet "$unit" 2>/dev/null && enabled_undeclared=$((enabled_undeclared + 1)) ;;
      esac
    fi
  fi
done

# The declaration file itself is load-bearing now: absent means every enablement
# claim below is unverifiable, and unverifiable must not read as healthy.
[ -f "$SRC/enabled-units" ] || cannot_say

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

# WHAT ARCHITECTURE IS THIS BOX. Added because planning the cTAZ containerized build
# turned up that the answer was written down nowhere: no `uname -m`, no `--platform`, no
# arch in any image pin, and this report did not say either. The answer had to be fetched
# by hand from the box, and a cross-build that guesses wrong ships a binary that will not
# execute. Measured-once-by-a-human is not the same as reported-every-run.
#
# Emitted as `unknown` rather than omitted when uname is unavailable, so a consumer can
# tell "we asked and could not tell" apart from "an older report that never asked".
platform="$(uname -m 2>/dev/null || echo unknown)"
[ -n "$platform" ] || platform="unknown"

# minerBinary is emitted as its own field as well as counted, so the panel can say WHY
# the count is short instead of only that it is. A number that drops with no reason
# attached sends someone to the box to find out.

# ── IS THE WATCHDOG CRASH-LOOPING? (#365) ───────────────────────────────────────
# A unit only triggers OnFailure= when it reaches the FAILED state, and a unit systemd
# keeps restarting never reaches it. faucet-watchdog has Restart=always and no start
# limit, deliberately, because a stack that recovers should find its supervisor still
# trying. The cost is that a watchdog whose script is broken restarts every 5 seconds
# forever and pages nobody. The service whose whole job is noticing that other things
# are broken was the one thing nothing watched.
#
# We keep never-give-up and report the loop instead of trading recovery for an alert.
#
# TWO FIGURES, AND THE DELTA IS THE ONE THAT MEANS ANYTHING. NRestarts is cumulative
# since the unit last started and never resets, so a box up thirty days with three
# restarts and a box looping right now can print similar numbers and a reader cannot
# tell which. A count with no rate is the same on-and-on flag as the old -dirty. The
# delta is measured against OUR OWN previous report, so it is restarts per report
# interval: at RestartSec=5 a real loop is around 60 per five minutes, while a box that
# restarted twice last week reads 0.
#
# Absent rather than zero when systemctl will not answer, because a number we could not
# read must not arrive as a reassuring one.
WATCHDOG_UNIT="${BOX_REPORT_WATCHDOG_UNIT:-faucet-watchdog.service}"
STATE="${BOX_REPORT_STATE:-/var/lib/faucet/box-report.state}"

watchdog_restarts=""
watchdog_restarts_delta=""
if n="$("$SYSTEMCTL" show -p NRestarts --value "$WATCHDOG_UNIT" 2>/dev/null)" \
   && [ -n "$n" ] && [ "$n" -eq "$n" ] 2>/dev/null; then
  watchdog_restarts="$n"
  prev="$(cat "$STATE" 2>/dev/null || true)"
  if [ -n "$prev" ] && [ "$prev" -eq "$prev" ] 2>/dev/null; then
    d=$((n - prev))
    # A negative delta means the counter reset under us, a daemon-reload or a reboot.
    # That is not "minus four restarts", it is a new baseline, so the delta is unknown
    # for this one report rather than a negative number nothing would know how to read.
    [ "$d" -ge 0 ] && watchdog_restarts_delta="$d"
  fi
  mkdir -p "$(dirname "$STATE")" 2>/dev/null && printf '%s\n' "$n" > "$STATE" 2>/dev/null || true
fi

# JSON numbers or the literal null. `null` is what an unread figure has to be on the
# wire: 0 would say the watchdog is calm, which is a claim we did not measure.
wr_json="${watchdog_restarts:-null}"
wrd_json="${watchdog_restarts_delta:-null}"

write "{\"expected\":${expected},\"present\":${present},\"notEnabled\":${not_enabled},\"enabledUndeclared\":${enabled_undeclared},\"minerBinary\":\"${miner_state}\",\"platform\":\"${platform}\",\"watchdogRestarts\":${wr_json},\"watchdogRestartsDelta\":${wrd_json},\"at\":$(( $(date +%s) * 1000 )),\"readable\":true}"
