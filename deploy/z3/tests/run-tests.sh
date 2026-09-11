#!/usr/bin/env bash
# The single entrypoint for the deploy/z3 shell-tooling tests. Runs every
# suite in suites/ and reports one total, so CI needs exactly one line.
#
#   suites/zsnap.sh   zsnap-export.sh and zsnap-import.sh
#   suites/backup.sh  backup.sh and restore-backup.sh
#   suites/deploy.sh  deploy.sh (bring-up order, wallet init, re-runs)
#   suites/repo.sh    claims the repo makes about itself in two places at once
#   suites/installops.sh  install-ops.sh, which had no suite and shipped broken for weeks
#
# Docker, zebrad, systemctl and curl are stubbed (tests/stubs for zsnap and
# backup, tests/deploy-stubs for deploy, which needs a different docker
# model). sqlite, tar, gpg and every hash check run for real.
#
# Needs Linux (flock, GNU find) plus zstd, gnupg, python3, jq, curl, git and
# openssh-server for the access suite. Missing ones are named and refused rather than reported as
# failures, so trust the refusal over guessing.
#
# `git` is in the install list because box-report dates the miner sources by COMMIT time,
# and the guard demands it. It was missing from this recipe while the guard already
# required it, so copy-pasting our own advice produced a refusal. Keep the two in step:
# anything suite_deps names has to be installable by the command printed here.
# `jq` joined for the same reason and made the same mistake once: the repo suite runs the
# live-smoke workflow's own --jq query, the guard started demanding jq, and the remedy
# below did not install it. The guard scans EVERY selected suite, so one missing name
# refuses the whole run, not one suite.
#
# From a Mac or a clean room:
#   docker run --rm -v "$(git rev-parse --show-toplevel)":/repo:ro ubuntu:24.04 \
#     bash -c 'set -e; apt-get update -qq
#              apt-get install -y -qq zstd curl gnupg python3 jq openssh-server git
#              useradd -m runner; cp -r /repo /home/runner/repo
#              chown -R runner /home/runner/repo
#              su runner -c "bash /home/runner/repo/deploy/z3/tests/run-tests.sh"'
# The `set -e` matters. An install that fails behind >/dev/null looks like the
# suite found real bugs.
# NOT as root, which is why the command above makes a user and copies the tree
# out of the read-only mount. As root, chmod cannot make a path unwritable, so
# watchdog's degrade case cannot be set up and reports a defect that is not there.
# Scratch state goes under TMPDIR, never into the repo.
#
# Suites are chosen with the SUITES env var, NOT positional arguments:
#   SUITES=deploy ./run-tests.sh          one suite
#   SUITES="drift alerts" ./run-tests.sh  a few
# `./run-tests.sh drift` silently runs all of them, which is easy to misread as
# a huge failure count from one suite.
set -uo pipefail

SCRATCH="${TEST_SCRATCH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO="${TEST_REPO:-$(cd "$SCRATCH/../../.." && pwd)}"
# The script paths and BASE_PATH below are read by the sourced suites, which
# the linter cannot see from here.
# shellcheck disable=SC2034
EXPORT="$REPO/deploy/z3/zsnap-export.sh"
# shellcheck disable=SC2034
IMPORT="$REPO/deploy/z3/zsnap-import.sh"
# shellcheck disable=SC2034
BACKUP="$REPO/deploy/z3/backup.sh"
# shellcheck disable=SC2034
RESTORE="$REPO/deploy/z3/restore-backup.sh"
# Each suite prepends its own stub dir to this, rather than to whatever the
# previous suite left on PATH.
# shellcheck disable=SC2034
BASE_PATH="$PATH"

# shellcheck source=lib.sh
. "$SCRATCH/lib.sh"

# THE ORDER IS DELIBERATE and stays written out: every suite is sourced into ONE shell, so
# what one leaves behind the next inherits, and this order is the one CI runs. Discovering
# the list from the directory would lose that, and a re-ordering has twice cost a review
# round on its own (a STUB_READY that meant a path in one suite and a flag in another).
#
# WHAT IS NOT WRITTEN OUT IS WHETHER IT IS COMPLETE. A suite file added and not named here
# never runs, on a green tally, which is the same silent-pass shape the suites themselves
# exist to catch. So the two are compared below and a mismatch refuses the run.
SUITE_ORDER="zsnap backup deploy metrics redeploy drift alerts access watchdog repo installops boxreport bringtospec ctazports ctazconfig ctazbroker prune imagemanifest autodeploy zalletrepair"
SELECTED="${SUITES:-$SUITE_ORDER}"

# Only when running the default set: a deliberately narrowed SUITES= is not a mismatch.
if [ -z "${SUITES:-}" ]; then
  on_disk=""; broken_links=""
  for f in "$SCRATCH"/suites/*.sh; do
    # -e is FALSE for a dangling symlink, so `[ -e ] || continue` dropped one silently:
    # a .sh-named entry sitting in suites/, never run, never mentioned, green tally. That
    # is the defect this guard exists for, arriving through the one door the guard did not
    # watch. -L catches the link itself regardless of where it points.
    if [ -L "$f" ] && [ ! -e "$f" ]; then
      broken_links="$broken_links ${f##*/}"
      continue
    fi
    [ -e "$f" ] || continue
    n="${f##*/}"; on_disk="$on_disk ${n%.sh}"
  done
  if [ -n "$broken_links" ]; then
    echo "REFUSING TO RUN: suites/ holds a broken symlink:$broken_links" >&2
    echo "It is named like a suite and can never run. Fix the target or remove it." >&2
    exit 2
  fi
  unlisted=""; missing_file=""
  for n in $on_disk; do
    case " $SUITE_ORDER " in *" $n "*) ;; *) unlisted="$unlisted $n" ;; esac
  done
  for n in $SUITE_ORDER; do
    case " $on_disk " in *" $n "*) ;; *) missing_file="$missing_file $n" ;; esac
  done
  # And NOT TWICE. Set membership says nothing about multiplicity, and a duplicate on that
  # one 20-name line is what a careless merge produces: the suite is sourced again, the
  # tally is inflated, and the second sourcing inherits the first one's leftovers.
  dupes=""
  for n in $SUITE_ORDER; do
    seen=0
    for m in $SUITE_ORDER; do [ "$m" = "$n" ] && seen=$((seen + 1)); done
    if [ "$seen" -gt 1 ]; then
      case " $dupes " in *" $n "*) ;; *) dupes="$dupes $n" ;; esac
    fi
  done
  if [ -z "$on_disk" ]; then
    # Not a disagreement, a wrong path: SCRATCH has no readlink, so invoking this through
    # a symlink resolves it to the link's directory and every name looks missing.
    echo "REFUSING TO RUN: no suites found under $SCRATCH/suites." >&2
    echo "That is a path problem, not a list problem - this script has no readlink, so" >&2
    echo "running it through a symlink resolves SCRATCH to the link's directory. Run it" >&2
    echo "by its real path, or set TEST_SCRATCH." >&2
    exit 2
  fi
  if [ -n "$unlisted" ] || [ -n "$missing_file" ] || [ -n "$dupes" ]; then
    echo "REFUSING TO RUN: the default suite order and deploy/z3/tests/suites/ disagree." >&2
    [ -n "$unlisted" ] && echo "  on disk but never run:$unlisted" >&2
    [ -n "$missing_file" ] && echo "  named in the order but no file:$missing_file" >&2
    [ -n "$dupes" ] && echo "  named more than once, so it would be sourced twice:$dupes" >&2
    echo >&2
    echo "A suite that is not named here does not run, and the tally is green anyway -" >&2
    echo "the exact silent pass these suites exist to catch. Add it to SUITE_ORDER, in the" >&2
    echo "position you want it sourced: the order is load-bearing, because every suite" >&2
    echo "shares one shell and inherits what the previous one left behind." >&2
    exit 2
  fi
fi

# A missing dependency used to look exactly like broken code. With no sshd on
# PATH the access suite reports 3 plain FAILs, and an `apt-get install` that
# quietly failed behind >/dev/null reported 25 at me, none of which named a
# cause. So refuse up front and say what to install, because a harness that
# cannot tell "not installed" from "defect" makes every number it prints
# suspect. Commands assumed present: coreutils, tar, flock, sed, awk.
suite_deps() { # $1 suite name -> commands it needs beyond the base set
  case "$1" in
    # Only suites that reach the REAL command are listed. Declaring one a suite
    # stubs is not harmless: it refuses to run a suite that would have passed,
    # withholding green tests while printing no numbers, which is the same
    # dishonesty as a phantom failure pointing the other way.
    #
    # curl is the trap. stubs/curl is first on PATH under fresh_env and
    # redeploy symlinks stubs/redeploy-curl over it, so most suites never touch
    # the real one. Only metrics and alerts deliberately step past the stub.
    # curl was MISSING from this list and it cost an hour. stubs/curl does fake the
    # readiness gate, which is why it was left out, but the publish and pointer tests
    # serve real archives over `python3 -m http.server` and fetch them with the REAL
    # curl. Without it seven assertions go red naming generations and pointer parsing,
    # which reads as a product bug in code that is fine.
    #
    # That is precisely what this guard exists to prevent, so its own list being
    # incomplete is the guard failing at its one job. Found by running the same suite
    # against origin/main in the same container and seeing the identical seven failures.
    zsnap)    echo "zstd python3 curl" ;;
    backup)   echo "gpg zstd python3" ;;
    redeploy) echo "" ;;               # stubs/redeploy-curl stands in for curl
    deploy)   echo "python3" ;;        # readiness is a stub script, lib.sh:60
    metrics)  echo "curl python3" ;;   # metrics.sh:16 builds a bin dir with
                                       # ONLY docker, so it gets the real curl
    # audit-access.sh asks sshd what it enforces. Without sshd the audit is
    # right to report NOT VERIFIED, but the suite asserts the resolved path.
    access)   echo "sshd" ;;
    alerts)   echo "python3 curl" ;;   # POSTs to a real local server
    # drift does NOT need curl, though I first thought it inherited the need.
    # report_env points DRIFT_ALERT_SH at its own stub, and the one test that
    # runs the shipped alert.sh runs it unconfigured, where send() returns 3
    # before reaching curl. Stubbed everywhere, early-exit in the one real case.
    #
    # jq is NOT listed: alert.sh encodes with jq OR python3, either one, and the
    # suites exercise the refusal path when neither exists.
    drift)    echo "python3" ;;
    # repo reads checked-in files only, so it needs nothing beyond the base set.
    # repo runs python3 now: it extracts the live-smoke workflow's own steps and executes
    # them, and without the interpreter those checks fail as though the workflow were
    # broken. A harness that cannot tell "not installed" from "defect" makes every number
    # it prints suspect, which is what this table exists to prevent.
    repo)     echo "python3 jq" ;;
    # installops copies files and asks systemctl via a stub; nothing beyond the base set.
    installops) echo "" ;;
    # boxreport reads files and asks a stubbed systemctl; python3 parses its JSON output.
    boxreport)  echo "python3" ;;
    # bringtospec composes the real install-ops and drives a cargo double; nothing extra.
    bringtospec) echo "" ;;
    # ctazbroker runs the real broker (python3) against a python3 node double.
    ctazbroker) echo "python3" ;;
    # zalletrepair drives a docker double it writes itself; nothing beyond the base set.
    zalletrepair) echo "" ;;
    # prune drives a docker double; GNU date is in the base set.
    prune) echo "" ;;
    *)        echo "" ;;
  esac
}

# A name check is not enough. macOS ships a `stat` and a `find` of the right
# name that lack `-c` and `-printf`, so the command resolves, the suite runs, and
# ~85 assertions fail as though the code were broken (#164).
#
# One of them is worse than a false failure. drift's read-only assertion compares
# two `sha256sum` listings, and with no sha256sum BOTH are empty, so they compare
# equal and the test reports ok while proving nothing. Verified: a file modified
# between the two listings is not detected. That test is what pins the audit's
# read-only promise, so a silent pass there is the worst outcome in this file.
#
# So probe the CAPABILITY, by running the flag, not by asking for the name.
suite_caps() { # $1 suite -> capability keys it needs
  case "$1" in
    backup)   echo "stat_c find_printf sha256sum" ;;
    zsnap)    echo "find_printf sha256sum" ;;
    metrics)  echo "stat_c" ;;
    drift)    echo "sha256sum" ;;
    # bring-to-spec.sh dates files with `stat -c %Y` too, and one assertion - the one that
    # skips a build and says why - goes red without it. Found by grepping which SHIPPED
    # scripts use a GNU-only flag and checking each one's suite against this table, rather
    # than by waiting for the next person to lose an hour to a red that was never real.
    bringtospec) echo "stat_c" ;;
    # verify-image-manifest.sh hashes with sha256sum; 7 assertions go red without it.
    # MEASURED, not assumed: sha256sum was replaced with an exit-127 stub and the suite
    # was run. Worth stating that it FAILS rather than silently passing, unlike drift's
    # read-only assertion described above - two empty listings compare equal, seven broken
    # hashes do not. A loud environmental red is still the wrong exit code, so it is
    # declared here, but it is not the dangerous shape.
    imagemanifest) echo "sha256sum" ;;
    # Not a tool, a property of who we are. See cap_probe.
    watchdog) echo "nonroot" ;;
    # box-report decides `stale` by comparing the binary against the COMMIT time of the
    # miner sources. Without git it falls back to mtime, and in that mode an older binary
    # is `unknown`, never `stale`, so the staleness assertions stop testing staleness and
    # go red for a reason that has nothing to do with the code. Infra hit exactly that and
    # nearly reported a bug on main.
    #
    # stat_c WAS MISSING FROM THIS LINE AND THE SAME THING HAPPENED AGAIN, one comment
    # further down the file that warns about it. box-report.sh dates both the sources and
    # the binary with `stat -c %Y`, and its `|| echo 0` fallback is correct on the box but
    # collapses every mtime to 0 on macOS, so the script reports `unknown` - which is the
    # honest answer to "could you read the timestamps" - and nine assertions expecting
    # `current` or `stale` go red as though box-report were broken.
    #
    # The full run already refused here, because backup and metrics declare stat_c. The
    # hole was only reachable through a NARROWED run, which is what this file's own
    # refusal message recommends: `SUITES="boxreport" ./run-tests.sh` exited 1 with nine
    # failures rather than exiting 2 with a reason. Exit 1 means the code is wrong; exit 2
    # means we could not tell. Spending the wrong one costs somebody the hour it takes to
    # prove main is fine, which is the hour it cost to find this.
    boxreport) echo "git stat_c" ;;
    *)        echo "" ;;
  esac
}

cap_probe() { # $1 key -> 0 when this host really has it
  case "$1" in
    stat_c)      stat -c %a . >/dev/null 2>&1 ;;
    find_printf) find . -maxdepth 0 -printf '' >/dev/null 2>&1 ;;
    sha256sum)   command -v sha256sum >/dev/null 2>&1 ;;
    # Root writes to a directory that has no write bit for it, so watchdog's
    # unwritable-state-dir case cannot be SET UP as root at all: the degrade path
    # never runs and the assertion goes red as though the watchdog were broken.
    # Exactly the #164 shape, with the missing capability being a user rather than
    # a GNU flag.
    nonroot)     [ "$(id -u)" != 0 ] ;;
    git)         command -v git >/dev/null 2>&1 ;;
    *)           return 0 ;;
  esac
}

cap_reason() { # $1 key -> what is missing, in the operator's terms
  case "$1" in
    stat_c)      echo "stat -c        GNU coreutils. BSD/macOS stat uses -f instead." ;;
    find_printf) echo "find -printf   GNU findutils. BSD/macOS find has no -printf." ;;
    sha256sum)   echo "sha256sum      GNU coreutils. macOS ships shasum instead." ;;
    nonroot)     echo "a non-root user  running as root, so chmod cannot make a path unwritable." ;;
    git)         echo "git            box-report dates sources by commit time; without it staleness is untestable." ;;
  esac
}

# THE PACKAGES THAT SATISFY suite_deps, in one place. The install line below is generated
# from this, so a command named in suite_deps and forgotten here is impossible rather than
# discovered by an operator who copy-pasted our own remedy and was refused again. That has
# happened twice: `git`, then `jq`.
# `-` means "deliberately not a package": a GNU behaviour or a property of who we are,
# which the capability refusal explains on its own. An EMPTY answer means nobody has said,
# and that is treated as a defect below rather than quietly dropped - dropping is exactly
# how `git` and then `jq` shipped missing from the remedy.
dep_package() { # $1 command or capability -> the apt package that provides it
  case "$1" in
    zstd)        echo zstd ;;
    curl)        echo curl ;;
    gpg)         echo gnupg ;;
    python3)     echo python3 ;;
    jq)          echo jq ;;
    sshd)        echo openssh-server ;;
    git)         echo git ;;
    # GNU behaviours (coreutils/findutils) and non-rootness: the capability refusal tells
    # you to use the Linux container as a normal user, which no package can do for you.
    stat_c|find_printf|sha256sum|nonroot) echo "-" ;;
    *)           echo "" ;;
  esac
}

# Every package any suite could ask for, in a stable order, whatever this run selected:
# the printed remedy has to work for the NEXT run too, not only for the narrowed one that
# refused. An empty answer from dep_package is itself a defect and is named, because a
# recipe that silently omits a command is how both earlier misses shipped.
ALL_PACKAGES=""
UNMAPPED=""
for _s in $SUITE_ORDER; do
  for _c in $(suite_deps "$_s") $(suite_caps "$_s"); do
    [ "$(dep_package "$_c")" = "-" ] && continue
    _p="$(dep_package "$_c")"
    if [ -z "$_p" ]; then
      case " $UNMAPPED " in *" $_c "*) ;; *) UNMAPPED="$UNMAPPED $_c" ;; esac
      continue
    fi
    case " $ALL_PACKAGES " in *" $_p "*) ;; *) ALL_PACKAGES="$ALL_PACKAGES $_p" ;; esac
  done
done
ALL_PACKAGES="${ALL_PACKAGES# }"
if [ -n "$UNMAPPED" ]; then
  echo "REFUSING TO RUN: suite_deps names commands with no package in dep_package:$UNMAPPED" >&2
  echo "The install line this script prints is generated from dep_package, so without an" >&2
  echo "entry the remedy would leave them out and refuse again. Add them." >&2
  exit 2
fi

missing=""
missing_caps=""
for suite in $SELECTED; do
  [ -f "$SCRATCH/suites/$suite.sh" ] || continue
  for cmd in $(suite_deps "$suite"); do
    command -v "$cmd" >/dev/null 2>&1 && continue
    case " $missing " in *" $cmd "*) ;; *) missing="$missing $cmd" ;; esac
  done
  for cap in $(suite_caps "$suite"); do
    cap_probe "$cap" && continue
    case " $missing_caps " in *" $cap "*) ;; *) missing_caps="$missing_caps $cap" ;; esac
  done
done

if [ -n "$missing_caps" ]; then
  echo "REFUSING TO RUN: this host has the commands these suites need but not the" >&2
  echo "behaviour they depend on. Run it as a normal user in the Linux container." >&2
  echo >&2
  for cap in $missing_caps; do echo "  missing: $(cap_reason "$cap")" >&2; done
  echo >&2
  echo "Running anyway is worse than a failure. Without the GNU tools most of those" >&2
  echo "assertions go red as though the code were broken, and drift's read-only check" >&2
  echo "goes GREEN without checking anything, because two empty sha256sum listings" >&2
  echo "compare equal. As root, watchdog's unwritable-state-dir assertion goes red for" >&2
  echo "the same false reason: root writes to the directory the test just made" >&2
  echo "unwritable, so the degrade path never runs and the watchdog looks broken." >&2
  echo >&2
  echo "  docker run --rm -v \"\$PWD:/repo:ro\" ubuntu:24.04 bash -c '" >&2
  echo "    set -e; apt-get update -qq" >&2
  echo "    apt-get install -y -qq $ALL_PACKAGES" >&2
  echo "    useradd -m runner; cp -r /repo /home/runner/repo" >&2
  echo "    chown -R runner /home/runner/repo" >&2
  echo "    su runner -c \"bash /home/runner/repo/deploy/z3/tests/run-tests.sh\"'" >&2
  exit 2
fi

if [ -n "$missing" ]; then
  echo "REFUSING TO RUN: these suites need commands this host does not have:" >&2
  for cmd in $missing; do echo "  missing: $cmd" >&2; done
  echo >&2
  echo "Running anyway would report them as test failures, which reads as broken" >&2
  echo "code rather than a missing package. On Ubuntu:" >&2
  echo "  apt-get update && apt-get install -y $ALL_PACKAGES" >&2
  echo >&2
  echo "Use 'set -e' on that install. A silently failed one is how 25 phantom" >&2
  echo "failures happen. Narrow the run instead with SUITES=\"drift alerts\"." >&2
  exit 2
fi

# A SELECTION THAT NAMES NOTHING IS NOT A PASS. `SUITES=" "` is not -z, so it skipped the
# order guard, selected zero suites, and exited 0 having sourced none of them - a green
# pipeline that ran nothing, which is the shape this file exists to refuse. Counted rather
# than string-tested, so it covers every way of arriving at an empty set.
_selected_count=0
for suite in $SELECTED; do _selected_count=$((_selected_count + 1)); done
if [ "$_selected_count" -eq 0 ]; then
  echo "REFUSING TO RUN: SUITES is set but names no suite (it was '${SUITES:-}')." >&2
  echo "Nothing would be sourced and the run would exit 0, which reads as a pass." >&2
  echo "Unset SUITES for the default order, or name one: SUITES=\"drift alerts\"." >&2
  exit 2
fi

for suite in $SELECTED; do
  file="$SCRATCH/suites/$suite.sh"
  [ -f "$file" ] || { bad "no such suite: $suite"; continue; }
  echo
  echo "### suite: $suite"
  # A SUITE THAT DOES NOT SOURCE IS A SUITE THAT DID NOT RUN, and until this it was a
  # GREEN one. `set -uo pipefail` carries no -e, so an unreadable file or a parse error
  # left `. "$file"` returning non-zero and the loop moved on: measured, a prune.sh with a
  # syntax error gave "23 passed, 0 failed" where 60 checks were due, exit 0. That is this
  # file's own subject - a suite nobody ran and nothing said so - one door over from the
  # list guard above, which is why it is not left to CI's shellcheck to catch one half of.
  #
  # THE EXIT STATUS OF `.` IS NOT THE EVIDENCE. `. file` returns whatever the suite's LAST
  # command returned, and ctazbroker.sh ends with `wait` on a process it just killed,
  # which is 143. The first cut of this floor read that as "did not source cleanly" and
  # failed a suite whose every check had passed - measured: 144 ok, then one FAIL saying
  # its checks never ran, exit 1 on the whole harness. A false alarm from the guard
  # against false passes.
  #
  # So the two real conditions are checked directly, BEFORE sourcing: can the file be
  # read, and does it parse. Those are the two shapes that were green before (an
  # unreadable prune.sh and one with a syntax error both gave "23 passed, 0 failed" where
  # sixty checks were due). After sourcing, the count is the evidence that it ran: pass
  # and fail are assigned in lib.sh, sourced above, and a suite that leaves them where it
  # found them asserted nothing, whatever the shell thought of its last line.
  if [ ! -r "$file" ]; then
    bad "suite $suite is not readable, so none of its checks ran"
    continue
  fi
  # Captured into a variable, NOT a file beside the suite: the tree is mounted read-only
  # in the harness container, and the first cut wrote the parse error to $SCRATCH - the
  # failed redirect then counted as a parse failure and every suite "did not parse" with
  # an empty message. A guard against false results that produces one is worse than none.
  if ! parse_err="$(bash -n "$file" 2>&1)"; then
    bad "suite $suite does not parse, so none of its checks ran: $(printf '%s' "$parse_err" | head -n1)"
    continue
  fi
  # shellcheck disable=SC2154 # pass and fail are assigned in lib.sh, sourced above
  before=$(( pass + fail ))
  # shellcheck source=/dev/null
  . "$file"
  # shellcheck disable=SC2154
  if [ "$(( pass + fail ))" -eq "$before" ]; then
    bad "suite $suite sourced but ran no checks at all, which is not a pass"
  fi
done

echo
# pass/fail are assigned in lib.sh, sourced above.
# shellcheck disable=SC2154
echo "$pass passed, $fail failed"
# shellcheck disable=SC2154
[ "$fail" -eq 0 ]
