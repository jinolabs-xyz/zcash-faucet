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
# Needs Linux (flock, GNU find) plus zstd, gnupg, python3, curl, and openssh-server
# for the access suite. Missing ones are named and refused rather than reported as
# failures, so trust the refusal over guessing. From a Mac or a clean room:
#   docker run --rm -v "$(git rev-parse --show-toplevel)":/repo:ro ubuntu:24.04 \
#     bash -c 'set -e; apt-get update -qq
#              apt-get install -y -qq zstd curl gnupg python3 openssh-server
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

SELECTED="${SUITES:-zsnap backup deploy metrics redeploy drift alerts access watchdog repo installops boxreport bringtospec}"

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
    repo)     echo "" ;;
    # installops copies files and asks systemctl via a stub; nothing beyond the base set.
    installops) echo "" ;;
    # boxreport reads files and asks a stubbed systemctl; python3 parses its JSON output.
    boxreport)  echo "python3" ;;
    # bringtospec composes the real install-ops and drives a cargo double; nothing extra.
    bringtospec) echo "" ;;
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
    # Not a tool, a property of who we are. See cap_probe.
    watchdog) echo "nonroot" ;;
    # box-report decides `stale` by comparing the binary against the COMMIT time of the
    # miner sources. Without git it falls back to mtime, and in that mode an older binary
    # is `unknown`, never `stale`, so the staleness assertions stop testing staleness and
    # go red for a reason that has nothing to do with the code. Infra hit exactly that and
    # nearly reported a bug on main.
    boxreport) echo "git" ;;
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
  echo "    apt-get install -y -qq zstd curl gnupg python3 openssh-server" >&2
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
  echo "  apt-get update && apt-get install -y zstd curl gnupg python3 openssh-server" >&2
  echo >&2
  echo "Use 'set -e' on that install. A silently failed one is how 25 phantom" >&2
  echo "failures happen. Narrow the run instead with SUITES=\"drift alerts\"." >&2
  exit 2
fi

for suite in $SELECTED; do
  file="$SCRATCH/suites/$suite.sh"
  [ -f "$file" ] || { bad "no such suite: $suite"; continue; }
  echo
  echo "### suite: $suite"
  # shellcheck source=/dev/null
  . "$file"
done

echo
# pass/fail are assigned in lib.sh, sourced above.
# shellcheck disable=SC2154
echo "$pass passed, $fail failed"
# shellcheck disable=SC2154
[ "$fail" -eq 0 ]
